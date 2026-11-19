package app.agentrelay.mobile

import android.app.*
import android.content.*
import android.content.pm.ServiceInfo
import android.net.*
import android.os.*
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.util.concurrent.Executors

class RelayService : Service() {
    private val worker = Executors.newSingleThreadExecutor()
    private var callback: ConnectivityManager.NetworkCallback? = null
    override fun onCreate() {
        super.onCreate()
        RelayNative.initialize(applicationContext)
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, RelayService::class.java).setAction("stop"), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, "connection").setSmallIcon(R.drawable.ic_stat_relay)
            .setContentTitle("Relay 后台连接").setContentText("等待电脑消息与审批")
            .setContentIntent(open).setOngoing(true).setSilent(true)
            .addAction(0, "停止后台连接", stop).build()
        ServiceCompat.startForeground(this, 1, notification, if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0)
        worker.execute {
            val error = RelayNative.boot()
            if (error.isNotEmpty()) {
                RelayNative.sendEvent("relay:mobileError", org.json.JSONObject().put("message", error).toString())
                stopSelf()
            } else RelayNative.active(true)
        }
        val manager = getSystemService(ConnectivityManager::class.java)
        var currentNetwork = manager.activeNetwork
        callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (network != currentNetwork) { currentNetwork = network; worker.execute { RelayNative.networkChanged() } }
            }
            override fun onLost(network: Network) { if (network == currentNetwork) currentNetwork = null }
        }.also { manager.registerDefaultNetworkCallback(it) }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "stop") {
            RelayNative.call(org.json.JSONObject().put("action", "background").put("value", org.json.JSONObject().put("enabled", false)).toString())
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }
    override fun onDestroy() {
        callback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        if (!RelayNative.foreground) RelayNative.active(false)
        worker.shutdown()
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
