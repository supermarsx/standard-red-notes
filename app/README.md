# Standard Red Notes

Standard Red Notes is a self-hosted-first fork of the Standard Notes app. It keeps end-to-end encrypted notes, files, and sync as the core product experience.

### Why Standard Red Notes?

- End-to-end encrypted sync. Only you can read your notes.
- Fast encrypted cross-platform sync on unlimited devices.
- Self-hosted app and server defaults for private deployments.
- Public source code under the upstream AGPL license.

### Creating your private notes account

1. Launch the Standard Red Notes web app.
2. Click Register to create your private notes account.
3. Build or install the forked clients for your devices.
4. You're all set. Standard Red Notes keeps end-to-end encrypted sync on all your devices.

### Publish a Blog

Standard Red Notes is a dependable environment to do your most important work, including publishing and exporting your writing from a self-hosted system.

### Community

Developers can create and publish their own extensions. Fork-owned community and support links should be added before public distribution.

---

### Self-hosting the web app

Our web app is compiled into a folder of static HTML, JS, and CSS files. You can serve these files behind a web server to get started:

1. `git clone https://github.com/supermarsx/standard-red-notes.git`
2. `cd standard-red-notes/app`
3. `yarn install`
4. `yarn build:web`
5. `cd packages/web`
6. You can then use Python to serve this folder over http: `python -m http.server 8080`

You can now access the app at `http://localhost:8080`.

### Running Web App in Development Mode

2. Clone the repo
3. `yarn install`
4. `yarn build:web`
5. `cd packages/web && yarn start`
6. Open your browser to `http://localhost:3001`.

---

You can configure the `DEFAULT_SYNC_SERVER` environment variable to set the default server for login and registration.

```
DEFAULT_SYNC_SERVER=https://sync.myserver
```
