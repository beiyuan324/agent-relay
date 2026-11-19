package app.agentrelay.mobile

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.net.*
import android.os.*
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object RelayNative {
    init { System.loadLibrary("agent_relay_lib") }
    lateinit var context: Context
    var activity = WeakReference<MainActivity>(null)
    @Volatile var foreground = true
    @Volatile var launchTarget = "{}"
    private val handler = Handler(Looper.getMainLooper())
    private val preferences get() = context.getSharedPreferences("relay", Context.MODE_PRIVATE)
    val backgroundEnabled get() = preferences.getBoolean("background", true)
    @JvmStatic external fun configure()
    @JvmStatic external fun boot(): String
    @JvmStatic external fun visibility(visible: Boolean, target: String)
    @JvmStatic external fun sendEvent(name: String, data: String)
    @JvmStatic external fun networkChanged()
    @JvmStatic external fun active(enabled: Boolean)

    fun initialize(appContext: Context) {
        context = appContext.applicationContext
        configure()
        channels()
    }
    private fun channels() {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("connection", "后台连接", NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(NotificationChannel("approval", "待处理审批", NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel("completion", "任务结果", NotificationManager.IMPORTANCE_DEFAULT))
    }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("relay.pairing", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder("relay.pairing", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    @Synchronized private fun writeSecret(id: String, code: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val value = Base64.encodeToString(cipher.iv + cipher.doFinal(code.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        check(context.getSharedPreferences("credentials", Context.MODE_PRIVATE).edit().putString(id, value).commit()) { "无法保存配对凭据" }
    }
    private fun readSecret(id: String): String {
        val value = context.getSharedPreferences("credentials", Context.MODE_PRIVATE).getString(id, null)
            ?: error("配对凭据不存在，请重新配对")
        val bytes = Base64.decode(value, Base64.NO_WRAP)
        require(bytes.size > 28) { "配对凭据已损坏，请重新配对" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }
    fun startBackground() {
        if (!backgroundEnabled) return
        handler.post {
            val current = activity.get()
            if (current != null && foreground) {
                ContextCompat.startForegroundService(context, Intent(context, RelayService::class.java))
                current.requestNotifications()
            }
        }
    }
    fun status(): JSONObject = JSONObject().apply {
        put("background", backgroundEnabled)
        put("notifications", Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
        put("batteryExempt", context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName))
        put("manufacturer", Build.MANUFACTURER)
        put("sdk", Build.VERSION.SDK_INT)
    }
    private fun settings(intent: Intent) {
        handler.post {
            val current = activity.get() ?: return@post
            val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))
            try { current.startActivity(if (intent.resolveActivity(context.packageManager) != null) intent else fallback) }
            catch (_: SecurityException) { current.startActivity(fallback) }
            catch (_: ActivityNotFoundException) { current.startActivity(fallback) }
        }
    }
    private fun event(event: JSONObject) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (event.optString("type") == "device") {
            val device = event.getJSONObject("device")
            if (!foreground && !device.optBoolean("approved")) notify("pair:" + device.getString("id"), "approval", "确认配对设备", "打开 Relay 核对设备身份", JSONObject().put("device", device.getString("id")))
            return
        }
        val device = event.getString("device")
        val message = event.getJSONObject("message")
        val method = message.optString("method")
        val params = message.optJSONObject("params") ?: JSONObject()
        if (method == "relay/approvalResolved" || method == "serverRequest/resolved") {
            manager.cancel(("approval:" + device + ":" + params.optString("id", params.optString("requestId"))).hashCode())
            return
        }
        if (foreground) return
        val target = JSONObject().put("device", device).put("threadId", params.optString("threadId"))
        when {
            message.has("id") -> { target.put("requestId", message.get("id")); notify("approval:" + device + ":" + message.get("id"), "approval", "有一项审批待处理", "打开会话查看并处理", target) }
            method == "turn/completed" -> {
                val turn = params.optJSONObject("turn") ?: JSONObject()
                val title = when (turn.optString("status")) { "failed" -> "任务执行失败"; "interrupted" -> "任务已停止"; else -> "任务已完成" }
                notify("turn:" + device + ":" + turn.optString("id", params.optString("turnId")), "completion", title, "打开 Relay 查看结果", target)
            }
        }
    }
    private fun notify(key: String, channel: String, title: String, text: String, target: JSONObject) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val intent = Intent(context, MainActivity::class.java).putExtra("relayTarget", target.toString()).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(context, key.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        context.getSystemService(NotificationManager::class.java).notify(key.hashCode(),
            NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.ic_stat_relay)
                .setContentTitle(title).setContentText(text).setContentIntent(pending).setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build())
    }
    @JvmStatic fun call(request: String): String = try {
        val input = JSONObject(request)
        val value = input.optJSONObject("value") ?: JSONObject()
        val result: Any? = when (input.getString("action")) {
            "dataPath" -> context.filesDir.absolutePath
            "deviceName" -> Build.MODEL
            "readSecret" -> readSecret(value.getString("id"))
            "writeSecret" -> { writeSecret(value.getString("id"), value.getString("code")); true }
            "deleteSecret" -> { check(context.getSharedPreferences("credentials", Context.MODE_PRIVATE).edit().remove(value.getString("id")).commit()) { "无法删除配对凭据" }; true }
            "startBackground" -> { startBackground(); true }
            "status" -> status()
            "launchTarget" -> { val target = JSONObject(launchTarget); launchTarget = "{}"; target }
            "lan" -> activity.get()?.ensureLocalNetwork() ?: error("请先打开 Relay 后授权局域网访问")
            "lanStatus" -> Build.VERSION.SDK_INT < 37 || context.applicationInfo.targetSdkVersion < 37 || ContextCompat.checkSelfPermission(context, "android.permission.ACCESS_LOCAL_NETWORK") == PackageManager.PERMISSION_GRANTED
            "background" -> {
                val enabled = value.getBoolean("enabled")
                check(preferences.edit().putBoolean("background", enabled).commit())
                handler.post {
                    if (enabled) startBackground() else {
                        context.stopService(Intent(context, RelayService::class.java))
                        if (!foreground) active(false)
                    }
                }
                status()
            }
            "notifications" -> { handler.post { activity.get()?.requestNotifications(true) }; true }
            "battery" -> { settings(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); true }
            "autostart" -> {
                val intent = if (Build.MANUFACTURER.equals("Xiaomi", true)) Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"))
                    else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))
                settings(intent); true
            }
            "theme" -> { handler.post { activity.get()?.applyTheme(value.optBoolean("dark")) }; true }
            "share" -> {
                handler.post {
                    activity.get()?.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, value.getString("text")), "分享配对邀请"))
                }; true
            }
            "event" -> { event(value); true }
            "updateStatus" -> AndroidUpdates.status()
            "checkUpdates" -> AndroidUpdates.check()
            "downloadUpdate" -> AndroidUpdates.download()
            "installUpdate" -> AndroidUpdates.install()
            else -> error("未知安卓系统操作")
        }
        JSONObject().put("ok", true).put("value", result ?: JSONObject.NULL).toString()
    } catch (error: Exception) {
        JSONObject().put("ok", false).put("error", error.message ?: "安卓系统操作失败").toString()
    }
}
