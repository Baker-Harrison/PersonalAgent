# PersonalAgent

A macOS app for working on local projects with an AI agent. Each project has a saved conversation, background workers, file attachments, and browser activity.

## Install

Download the Apple Silicon ZIP from [Releases](https://github.com/Baker-Harrison/PersonalAgent/releases), extract it, and move PersonalAgent.app into Applications. Sign in when the app opens, then add a project folder.

Early testing builds are not Developer ID signed or notarized. macOS may block them. The ZIP includes the Node runtime; no separate Node installation is needed for the packaged app.

The agent can execute commands and modify files in your selected projects. Workers share the project folder. Use version control and review changes during testing.

## Updates

An update button appears at the bottom of the left sidebar when a newer published release is available. It opens the GitHub release page. Quit the app, download the new version, and replace the app. Your projects and conversations remain in `~/Library/Application Support/PersonalAgent/`.

## Development

Requires macOS on Apple Silicon and Node.js 24 or newer.

```sh
npm ci
npm run desktop
```

```sh
npm run typecheck
npm test
npm run release:artifacts
```

The final command produces a ZIP and SHA-256 checksum in `release/`. See [the release process](docs/releases.md).

The desktop uses Electron, Eve, and Pi. ChatGPT authentication is stored locally, outside the repository. Never commit credentials or application data. Browser actions require the app to remain open; background command work can continue after the window closes.

## Reporting issues

Include your app version, macOS version, steps to reproduce, and what you expected. Remove credentials and private conversation content from logs or screenshots before posting.

## License

ISC. Dependency licenses remain with their respective authors.
