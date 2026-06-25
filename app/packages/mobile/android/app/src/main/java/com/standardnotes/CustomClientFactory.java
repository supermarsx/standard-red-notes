package com.standardnotes;

import com.facebook.react.modules.network.OkHttpClientFactory;
import com.facebook.react.modules.network.OkHttpClientProvider;
import com.facebook.react.modules.network.ReactCookieJarContainer;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;

/**
 * Self-hosted fork: certificate pinning against the hosted Standard Notes
 * domains (*.standardnotes.com / *.standardnotes.org) has been removed. Pinning
 * to SN's certificates would block connections to an operator's own self-hosted
 * server. The standard OS trust store is used instead.
 *
 * Operators who want certificate pinning for their OWN domain can re-introduce
 * an okhttp3.CertificatePinner here with their server's public-key hashes.
 */
public class CustomClientFactory implements OkHttpClientFactory {
    @Override
    public OkHttpClient createNewNetworkModuleClient() {
        OkHttpClient.Builder client = new OkHttpClient.Builder()
                .connectTimeout(0, TimeUnit.MILLISECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .writeTimeout(0, TimeUnit.MILLISECONDS)
                .cookieJar(new ReactCookieJarContainer());
        return client.build();
    }
}