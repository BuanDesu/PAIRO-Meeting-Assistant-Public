package com.pairo.meetingcopilot;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "ModelStream")
public class ModelStreamPlugin extends Plugin {
    private final ConcurrentHashMap<String, Request> requests = new ConcurrentHashMap<>();
    private final ExecutorService workers = Executors.newFixedThreadPool(2);
    private final ExecutorService cancellations = Executors.newSingleThreadExecutor();

    private static class Request {
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
    }

    @PluginMethod
    public synchronized void start(PluginCall call) {
        String id = call.getString("id", "");
        String address = call.getString("url", "");
        String key = call.getString("apiKey", "");
        String body = call.getString("body", "");
        if (!id.matches("[a-zA-Z0-9-]{1,80}") || key.isEmpty() || key.contains("\r") || key.contains("\n") || body.length() > 4500000) {
            call.reject("模型请求参数无效"); return;
        }
        final URL url;
        try {
            url = new URL(address);
            boolean local = url.getHost().equals("localhost") || url.getHost().equals("127.0.0.1") || url.getHost().equals("[::1]");
            if (url.getUserInfo() != null || !(url.getProtocol().equals("https") || (local && url.getProtocol().equals("http")))) {
                call.reject("API 地址必须使用 HTTPS，且不能包含登录信息"); return;
            }
        } catch (Exception ignored) { call.reject("API 地址格式不正确"); return; }
        if (requests.size() >= 2 || requests.containsKey(id)) { call.reject("模型连接繁忙，请稍后重试"); return; }
        Request request = new Request();
        requests.put(id, request);
        call.resolve();
        workers.execute(() -> run(id, request, url, key, body));
    }

    private void emit(String id, Request request, String type, JSObject data) {
        if (request.cancelled) return;
        data.put("id", id); data.put("type", type);
        // Serialize event delivery on the same bridge handler as listener registration/removal.
        execute(() -> { if (!request.cancelled) notifyListeners("stream", data); });
    }

    private void run(String id, Request request, URL url, String key, String body) {
        HttpURLConnection connection = null;
        try {
            if (request.cancelled) return;
            connection = (HttpURLConnection) url.openConnection();
            request.connection = connection;
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(60000);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "text/event-stream, application/json");
            connection.setRequestProperty("Authorization", "Bearer " + key);
            connection.setDoOutput(true);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            if (request.cancelled) return;
            try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            int status = connection.getResponseCode();
            emit(id, request, "headers", new JSObject().put("status", status).put("contentType", connection.getContentType()));
            InputStream input = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            if (input != null) {
                try (InputStreamReader reader = new InputStreamReader(input, StandardCharsets.UTF_8)) {
                    char[] buffer = new char[2048];
                    int count, total = 0;
                    while (!request.cancelled && (count = reader.read(buffer)) != -1) {
                        total += count;
                        if (total > (status >= 200 && status < 300 ? 2000000 : 16384)) throw new IllegalStateException();
                        emit(id, request, "chunk", new JSObject().put("text", new String(buffer, 0, count)));
                    }
                }
            }
            emit(id, request, "end", new JSObject());
        } catch (Exception ignored) {
            // Do not log provider details, URLs, credentials, prompts or images.
            emit(id, request, "error", new JSObject().put("message", "模型网络连接中断，请检查网络后重试"));
        } finally {
            if (connection != null) connection.disconnect();
            request.connection = null;
            requests.remove(id, request);
        }
    }

    private void cancelRequest(Request request) {
        request.cancelled = true;
        cancellations.execute(() -> { HttpURLConnection connection = request.connection; if (connection != null) connection.disconnect(); });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Request request = requests.get(call.getString("id", ""));
        if (request != null) cancelRequest(request);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (Request request : requests.values()) cancelRequest(request);
        workers.shutdownNow();
        cancellations.shutdown();
    }
}
