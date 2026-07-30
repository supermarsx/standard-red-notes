package com.standardnotes;

import com.reactnativecommunity.webview.RNCWebView;
import com.reactnativecommunity.webview.RNCWebViewClient;
import com.reactnativecommunity.webview.RNCWebViewManager;
import com.reactnativecommunity.webview.RNCWebViewManagerImpl;
import com.facebook.react.uimanager.ThemedReactContext;
import android.view.inputmethod.InputConnectionWrapper;
import com.facebook.react.module.annotations.ReactModule;
import com.reactnativecommunity.webview.RNCWebViewWrapper;

import android.net.Uri;
import android.view.KeyEvent;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

import androidx.annotation.NonNull;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.Collections;

@ReactModule(name = CustomWebViewManager.REACT_CLASS)
public class CustomWebViewManager extends RNCWebViewManager {
	/* This name must match what we’re referring to in JS */
	protected static final String REACT_CLASS = "CustomWebView";
	private final RNCWebViewManagerImpl managerImplementation = new RNCWebViewManagerImpl(true);

	protected static class CustomWebViewClient extends RNCWebViewClient {}

	protected static class CustomWebView extends RNCWebView {
		private static final String TRUSTED_APP_SCHEME = "file";
		private static final String TRUSTED_APP_PATH = "/android_asset/Web.bundle/src/index.html";

		public CustomWebView(ThemedReactContext reactContext) {
			super(reactContext);
		}

		private boolean hasTrustedTopDocument() {
			String currentUrl = getUrl();
			if (currentUrl == null) {
				return false;
			}

			Uri parsedUrl = Uri.parse(currentUrl);
			String host = parsedUrl.getHost();
			return TRUSTED_APP_SCHEME.equalsIgnoreCase(parsedUrl.getScheme())
				&& (host == null || host.isEmpty())
				&& TRUSTED_APP_PATH.equals(parsedUrl.getPath());
		}

		/**
		 * Keep the main-frame bit at the native boundary instead of forwarding
		 * every frame into React Native and trying to infer its origin later.
		 */
		@Override
		protected void createRNCWebViewBridge(RNCWebView webView) {
			if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
				return;
			}

			if (bridgeListener == null) {
				bridgeListener = (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
					if (!isMainFrame || !hasTrustedTopDocument()) {
						return;
					}

					onMessage(message.getData(), getUrl());
				};
				WebViewCompat.addWebMessageListener(
					webView,
					JAVASCRIPT_INTERFACE,
					Collections.singleton("*"),
					bridgeListener
				);
			}
		}

		/**
		 * The legacy addJavascriptInterface fallback is injected into every
		 * frame and cannot authenticate the caller. Fail closed until the
		 * system WebView provides WEB_MESSAGE_LISTENER.
		 */
		@Override
		public void setMessagingEnabled(boolean enabled) {
			if (enabled && !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
				super.setMessagingEnabled(false);
				return;
			}

			super.setMessagingEnabled(enabled);
		}

		@Override
		public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
			InputConnection con = super.onCreateInputConnection(outAttrs);
			if (con == null) {
				return null;
			}
			return new CustomInputConnection(con, true);
		}

		private class CustomInputConnection extends InputConnectionWrapper {
			public CustomInputConnection(InputConnection target, boolean mutable) {
				super(target, mutable);
			}

			@Override
			public boolean sendKeyEvent(KeyEvent event) {
				if (event.getAction() == KeyEvent.ACTION_DOWN && event.getKeyCode() == KeyEvent.KEYCODE_DEL) {
					// Un-comment if you wish to cancel the backspace:
					// return false;
				}
				return super.sendKeyEvent(event);
			}

			@Override
			public boolean deleteSurroundingText(int beforeLength, int afterLength) {
				// magic: in latest Android, deleteSurroundingText(1, 0) will be called for backspace
				if (beforeLength == 1 && afterLength == 0) {
					// backspace
					return sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL))
						&& sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DEL));
				}
				return super.deleteSurroundingText(beforeLength, afterLength);
			}
		}
	}

	@Override
	public RNCWebViewWrapper createViewInstance(ThemedReactContext reactContext) {
		return managerImplementation.createViewInstance(reactContext, new CustomWebView(reactContext));
	}

	@Override
	public String getName() {
		return REACT_CLASS;
	}

	@Override
	protected void addEventEmitters(@NonNull ThemedReactContext reactContext, RNCWebViewWrapper viewWrapper) {
		viewWrapper.getWebView().setWebViewClient(new CustomWebViewClient());
	}
}
