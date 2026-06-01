# Security Policy

## Supported versions

The public repository tracks the `main` branch while the project is early.
Security fixes should target `main`.

## Reporting a vulnerability

Open a private security advisory on GitHub if available. If not, contact the
maintainer through the GitHub profile linked from the repository.

Please include:

- A concise description of the issue.
- Reproduction steps.
- Whether the issue exposes local files, environment variables, OAuth tokens,
  generated media, or downloaded source content.
- The affected commit or version.

## Security boundaries

Live Clip Factory is intended to run locally. It handles local media files,
SQLite data, generated clips, optional OpenAI API keys, optional YouTube cookie
configuration, and optional Google Drive OAuth credentials. Do not commit real
credentials, runtime databases, downloaded media, rendered output, or cookies.
