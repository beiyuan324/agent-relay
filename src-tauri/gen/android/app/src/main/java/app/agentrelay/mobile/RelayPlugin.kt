package app.agentrelay.mobile

import android.app.Activity
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.core.graphics.Insets
import androidx.core.view.*
import app.tauri.plugin.Plugin
import app.tauri.annotation.TauriPlugin
import java.lang.ref.WeakReference
import kotlin.math.max

@TauriPlugin
class RelayPlugin(private val host: Activity) : Plugin(host) {
    override fun load(webView: WebView) {
        val activity = host as MainActivity
        activity.web = WeakReference(webView)
        ViewCompat.setOnApplyWindowInsetsListener(activity.window.decorView) { _, insets ->
            // 此处已收到键盘动画的最终尺寸，不再逐帧改写边距。
            applyInsets(webView, insets)
            // 保留 Insets 更新分发，但不让 WebView 重复避让原生已处理的区域。
            WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build()
        }
        ViewCompat.requestApplyInsets(activity.window.decorView)
        activity.onBackPressedDispatcher.addCallback(activity, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("Boolean(window.__relayBack && window.__relayBack())") { handled ->
                    if (handled != "true") activity.moveTaskToBack(true)
                }
            }
        })
    }
    private fun applyInsets(webView: WebView, insets: WindowInsetsCompat) {
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val params = webView.layoutParams as ViewGroup.MarginLayoutParams
        val bottom = max(bars.bottom, ime.bottom)
        if (params.leftMargin != bars.left || params.topMargin != bars.top || params.rightMargin != bars.right || params.bottomMargin != bottom) {
            params.setMargins(bars.left, bars.top, bars.right, bottom)
            webView.layoutParams = params
        }
    }
}
