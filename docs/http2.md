# Serving Pi Web over HTTP/2

Over HTTP/1.1, browsers typically share six connections to one origin across their tabs. Each active chat, terminal and watched file can hold a long-lived event stream. With enough streams open, other requests (sending a message, opening Settings) wait in the browser until a connection is free. HTTPS alone does not change this limit.

Pi Web already releases a hidden tab's idle chat stream and file watch after 30 seconds. Terminal streams stay open to keep their shells alive. If you keep many streams active, serve Pi Web over HTTP/2: several streams can share a connection, avoiding this particular HTTP/1.1 bottleneck. HTTP/2 still has negotiated stream and resource limits; it does not fix every cause of a slow page. Browsers use HTTP/2 over HTTPS, so use an existing trusted HTTPS reverse proxy or the local Caddy setup below. Pi Web itself needs no change.

## Locally, with Caddy

[Caddy](https://caddyserver.com/) can create a local certificate and serve HTTP/2 in front of either `pi-web` or `npm run dev`. Keep Pi Web listening on its default `127.0.0.1:30141`.

Save this as `Caddyfile`:

```caddyfile
{
    auto_https disable_redirects
    skip_install_trust
}

localhost:8443 {
    bind 127.0.0.1
    tls internal
    reverse_proxy 127.0.0.1:30141
}
```

Start Pi Web, then run Caddy in another terminal:

```bash
caddy run --config ./Caddyfile --adapter caddyfile
```

The explicit `bind` matters: `caddy reverse-proxy --from localhost:8443 ...` matches the `Host` header but listens on all interfaces, not just loopback. A remote client can send that same header. `auto_https disable_redirects` also avoids opening an HTTP redirect listener on port 80. Do not remove these restrictions for a local-only setup.

This configuration creates a local certificate authority (CA) but does **not** install it into any trust store. To use it in your normal browser, first decide whether to trust that CA, then run `caddy trust` in another terminal while Caddy is running, under the same user. That explicitly changes local trust stores and may require administrator permission. Automatic trust is not guaranteed in every browser, container or service environment; see [Caddy's local HTTPS guidance](https://caddyserver.com/docs/automatic-https#local-https). Do not work around a trust failure by disabling certificate verification globally.

Once the browser trusts the CA, open <https://localhost:8443>. Use `localhost`, the certificate's name, rather than another machine's address. Caddy preserves `Host` and supplies `X-Forwarded-Proto`, which Pi Web uses for its origin checks and Secure login cookie. Its default reverse proxy flushes `text/event-stream` responses as they arrive; no extra buffering directive is needed. It also forwards the development server's WebSocket connection for hot module replacement (HMR).

In the browser's developer tools, Network panel, `h2` confirms HTTP/2 (`h3` is HTTP/3, also multiplexed). A lock icon alone proves neither HTTP/2 nor freedom from connection-pool starvation. A manual concurrency regression is described in [the E2E guide](../e2e/README.md#http2-connection-pool-regression-manual).

## Remote access

The loopback setup above is intentionally not reachable from another device. For remote access, use an HTTPS proxy with a hostname and certificate that the client trusts, or `tailscale serve` on an existing Tailscale network. Trusting Caddy's local CA on the server does not make a phone or another computer trust it; each client needs trust configured, unless you use a certificate it already trusts.

Keep Pi Web bound to `127.0.0.1` behind the proxy, keep a password set (`PI_WEB_PASSWORD`), and add the external hostname to `PI_WEB_ALLOWED_HOSTS`, as described under Remote Access in the [README](../README.md#remote-access). The proxy must preserve the external `Host` and send the correct `X-Forwarded-Proto`; do not weaken Pi Web's host/origin checks to make a proxy work.
