# express-ready — pre-wired smoke fixture

Same trivial Express server as `examples/express-server`, but ships with a hand-crafted `agentbox.yaml` so it can be created non-interactively. Used by the Portless smoke test on the Hetzner provider.

```bash
cd examples/express-ready
cp .env.example .env
node ../../apps/cli/dist/index.js create --provider hetzner -y -n smoke
# After ready:
curl http://smoke.localhost:1355   # via host portless proxy
```

`expose.port: 3000` routes the supervisor's WebProxy (`:80` inside the box) to the Express server. The Hetzner provider also runs a `portless` mirror inside the VPS so `http://smoke.localhost:1355` resolves to the same content from the in-box browser.
