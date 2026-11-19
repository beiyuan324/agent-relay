package app.agentrelay.mobile

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

object AndroidUpdates {
    private var manifest: JSONObject? = null
    private val current = JSONObject().apply {
        put("revision", 0L); put("phase", if (BuildConfig.DEBUG) "development" else "idle")
        put("currentVersion", BuildConfig.VERSION_NAME); put("version", JSONObject.NULL); put("notes", JSONObject.NULL)
        put("downloaded", 0L); put("total", JSONObject.NULL); put("lastChecked", JSONObject.NULL); put("error", JSONObject.NULL)
    }
    private var busy = false
    private val apk get() = File(RelayNative.context.cacheDir, "updates/Relay-update.apk")
    @Synchronized fun status(): JSONObject = JSONObject(current.toString())
    @Synchronized private fun publish(change: JSONObject.() -> Unit): JSONObject {
        current.change()
        current.put("revision", current.getLong("revision") + 1)
        RelayNative.sendEvent("relay:update", current.toString())
        return status()
    }
    @Synchronized private fun begin(): Boolean {
        if (busy || BuildConfig.DEBUG) return false
        busy = true
        return true
    }
    @Synchronized private fun finish() { busy = false }
    private fun connect(url: URL): HttpURLConnection {
        var target = url
        repeat(6) {
            require(target.protocol == "https") { "更新地址必须使用 HTTPS" }
            val connection = target.openConnection() as HttpURLConnection
            connection.connectTimeout = 15000; connection.readTimeout = 60000; connection.instanceFollowRedirects = false
            connection.setRequestProperty("User-Agent", "Relay/" + BuildConfig.VERSION_NAME)
            val code = connection.responseCode
            if (code in listOf(301, 302, 303, 307, 308)) {
                val location = connection.getHeaderField("Location") ?: error("更新下载重定向地址缺失")
                target = URL(target, location); connection.disconnect()
            } else {
                if (code != 200) { connection.disconnect(); error(if (code == 404) "尚未发布安卓更新" else "更新服务返回 HTTP " + code) }
                return connection
            }
        }
        error("更新服务重定向次数过多")
    }
    fun check(): JSONObject {
        if (!begin()) return status()
        publish { put("phase", "checking"); put("error", JSONObject.NULL) }
        try {
            val connection = connect(URL("https://github.com/beiyuan324/agent-relay/releases/latest/download/android-latest.json"))
            val text = try {
                connection.inputStream.use { input ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                        val size = input.read(buffer); if (size < 0) break
                        require(output.size() + size <= 1024 * 1024) { "更新清单过大" }
                        output.write(buffer, 0, size)
                    }
                    output.toString("UTF-8")
                }
            } finally { connection.disconnect() }
            val next = JSONObject(text)
            require(next.getString("appId") == BuildConfig.APPLICATION_ID) { "更新应用标识不一致" }
            require(next.getString("sha256").matches(Regex("[a-fA-F0-9]{64}"))) { "更新校验值无效" }
            require(URL(next.getString("url")).protocol == "https") { "更新地址必须使用 HTTPS" }
            val available = next.getLong("versionCode") > BuildConfig.VERSION_CODE.toLong()
            manifest = if (available) next else null
            publish {
                put("phase", if (available) "available" else "upToDate")
                put("version", if (available) next.getString("version") else JSONObject.NULL)
                put("notes", next.optString("notes")); put("lastChecked", System.currentTimeMillis())
                put("downloaded", 0); put("total", JSONObject.NULL)
            }
        } catch (error: Exception) {
            publish { put("phase", if (manifest == null) "error" else "available"); put("error", error.message); put("lastChecked", System.currentTimeMillis()) }
        } finally { finish() }
        return status()
    }
    @Suppress("DEPRECATION")
    private fun version(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    @Suppress("DEPRECATION")
    private fun certificates(info: PackageInfo): List<String> {
        val values = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        return values?.map { signature -> hex(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())) }?.sorted() ?: emptyList()
    }
    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun verify(file: File, metadata: JSONObject) {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val size = input.read(buffer); if (size < 0) break; digest.update(buffer, 0, size) } }
        require(hex(digest.digest()).equals(metadata.getString("sha256"), true)) { "安装包校验失败，请重新下载" }
        @Suppress("DEPRECATION")
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val manager = RelayNative.context.packageManager
        @Suppress("DEPRECATION")
        val archive = manager.getPackageArchiveInfo(file.absolutePath, flags) ?: error("安装包格式无效")
        @Suppress("DEPRECATION")
        val installed = manager.getPackageInfo(BuildConfig.APPLICATION_ID, flags)
        require(archive.packageName == BuildConfig.APPLICATION_ID && version(archive) == metadata.getLong("versionCode") && version(archive) > version(installed)) { "安装包应用或版本不匹配" }
        val signatures = certificates(archive)
        require(signatures.isNotEmpty() && signatures == certificates(installed)) { "安装包签名与当前应用不一致" }
    }
    fun download(): JSONObject {
        if (!begin()) return status()
        val metadata = manifest
        if (metadata == null) { finish(); return publish { put("error", "请先检查更新") } }
        publish { put("phase", "downloading"); put("downloaded", 0); put("error", JSONObject.NULL) }
        val part = File(apk.parentFile, "Relay-update.part")
        try {
            check(apk.parentFile!!.exists() || apk.parentFile!!.mkdirs()) { "无法创建更新目录" }
            val connection = connect(URL(metadata.getString("url")))
            try {
                val length = connection.contentLengthLong
                require(length <= 256L * 1024 * 1024) { "安装包过大" }
                publish { put("total", if (length > 0) length else JSONObject.NULL) }
                connection.inputStream.use { input ->
                    part.outputStream().use { output ->
                        val buffer = ByteArray(65536); var total = 0L; var last = 0L
                        while (true) {
                            val size = input.read(buffer); if (size < 0) break
                            total += size
                            require(total <= 256L * 1024 * 1024) { "安装包过大" }
                            output.write(buffer, 0, size)
                            if (System.currentTimeMillis() - last > 150) { publish { put("downloaded", total) }; last = System.currentTimeMillis() }
                        }
                        output.fd.sync()
                        publish { put("downloaded", total) }
                    }
                }
            } finally { connection.disconnect() }
            verify(part, metadata)
            check(!apk.exists() || apk.delete()) { "无法替换旧安装包" }
            check(part.renameTo(apk)) { "无法保存安装包" }
            publish { put("phase", "ready") }
        } catch (error: Exception) {
            part.delete()
            publish { put("phase", "available"); put("error", error.message) }
        } finally { finish() }
        return status()
    }
    fun install(): JSONObject {
        if (!begin()) return status()
        try {
            val metadata = manifest ?: error("请先检查更新")
            require(apk.exists()) { "请先下载安装包" }
            verify(apk, metadata)
            val activity = RelayNative.activity.get() ?: error("请先打开 Relay 后安装更新")
            if (!RelayNative.context.packageManager.canRequestPackageInstalls()) {
                Handler(Looper.getMainLooper()).post { activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + BuildConfig.APPLICATION_ID))) }
                publish { put("phase", "ready"); put("error", "允许 Relay 安装应用后，返回并再次点击安装") }
            } else {
                val uri = FileProvider.getUriForFile(RelayNative.context, BuildConfig.APPLICATION_ID + ".fileprovider", apk)
                Handler(Looper.getMainLooper()).post {
                    try {
                        activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                    } catch (error: Exception) { publish { put("phase", "ready"); put("error", error.message) } }
                }
                publish { put("phase", "installing"); put("error", JSONObject.NULL) }
            }
        } catch (error: Exception) { publish { put("phase", "ready"); put("error", error.message) } }
        finally { finish() }
        return status()
    }
    fun resumed() { if (status().optString("phase") == "installing") publish { put("phase", "ready") } }
}
