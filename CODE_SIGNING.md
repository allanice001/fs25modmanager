# Code signing policy

This document is the published code signing policy for **FS25 Mod Manager**, as
required by the SignPath Foundation free code signing programme.

It is also published on the project homepage, which is the canonical copy
SignPath is pointed at:
<https://allanice001.github.io/fs25modmanager/#code-signing>
(source: [`docs/index.html`](docs/index.html)). Keep the two in step.

## Certificate and signing

Free code signing for the Windows binaries of this project is provided by
[SignPath.io](https://signpath.io/), with a certificate issued by the
[SignPath Foundation](https://signpath.org/).

Signing happens **only** inside the project's public GitHub Actions release
pipeline (`.github/workflows/release.yml`), triggered by pushing a version tag.
No maintainer holds the signing key, and no binary is signed from a local
machine. SignPath verifies that each submitted artifact was produced by that
pipeline from this repository before it is signed. See the
[SignPath documentation](https://docs.signpath.io/) for how this verification
works.

macOS builds are signed and notarized separately with an Apple Developer ID
certificate held by the maintainer; that is unrelated to the SignPath
Foundation certificate.

## Team roles

This is a single-maintainer project. All three SignPath roles are currently
held by the same person, and this section will be updated if that changes.

| Role | Who | Responsibility |
| --- | --- | --- |
| Author | [@allanice001](https://github.com/allanice001) (Johan Allan Swanepoel) | Writes and modifies source code |
| Reviewer | [@allanice001](https://github.com/allanice001) | Reviews and approves changes to `main` |
| Approver | [@allanice001](https://github.com/allanice001) | Authorises releases and signing requests |

Multi-factor authentication is enabled on all accounts with write access to
this repository and on the SignPath account.

## Privacy statement

FS25 Mod Manager does not collect analytics, telemetry, or personal data, and
does not transmit any information about you or your files to the maintainer.

The application makes network requests only in these cases, all of them
initiated by something you do in the app:

- **Farming Simulator ModHub** (`farming-simulator.com`) — when you browse or
  search mods in the in-app Discover view. Responses are cached locally.
- **Giants Software CDN** (`giants-software.com`) — when you download a mod you
  selected in Discover. This is the same host the ModHub website itself serves
  downloads from.
- **GitHub Releases** (`github.com`) — when the app checks for an update to
  itself, so it can tell you a new version exists.

All other functionality — your mod library, configuration, tag catalog, and
scenario data — is stored locally on your own machine and never leaves it. The
application does not require an account and has no server component operated by
the maintainer.

## Reporting a problem

If you believe a signed binary attributed to this project is malicious,
tampered with, or was not built from this repository, please open an issue at
<https://github.com/allanice001/fs25modmanager/issues> and, if it concerns the
certificate itself, contact the SignPath Foundation.
