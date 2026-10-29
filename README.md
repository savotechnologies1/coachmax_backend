# coachmax_backend

## Production deployment

The `main` branch runs backend checks on every push. To enable deployment after
those checks pass, set the repository Actions variable `DEPLOY_ENABLED` to
`true` and configure:

- Variables: `DEPLOY_USER`, `DEPLOY_PATH` (the backend application directory
  containing `server.js`), and optionally `DEPLOY_HOST` (defaults to
  `50.6.44.47`), `DEPLOY_PORT` (defaults to `22`), and `PM2_APP_NAME` (defaults
  to `coachmax`).
- Secret: `DEPLOY_SSH_KEY`, the private SSH key whose public key is authorized
  for that server account.

The server must have Node.js 22, npm, rsync, and PM2. Keep the production `.env`
and uploads on the server; the workflow excludes them from file sync. Manual
deployment is available through `workflow_dispatch` on `main`.
