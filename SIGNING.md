# Signing the Windows app

Releases are signed through **SignPath.io's free program for open source**, with a
certificate issued by **SignPath Foundation**. The release workflow already supports it;
it switches to signing as soon as the settings below exist. Until then it publishes
unsigned installers.

## 1. Apply (once, by the repository owner)

SignPath Foundation's conditions ([terms](https://signpath.org/terms)) and where Agilos
stands:

| Condition | Status |
| --- | --- |
| OSI-approved licence for all code | Done: MIT ([LICENSE](LICENSE)); assets are CC0 / SIL OFL |
| No malware, no proprietary code, maintained | Done |
| Version already released | Done after the first unsigned release (v0.2.0) |
| Functionality described on the download page | Done: [README](README.md) and release notes |
| "Code signing policy" on the home and download pages, with team roles and privacy | Done: [README](README.md#code-signing-policy), release notes, in-game download panel |
| Multi-factor authentication for every team member on GitHub and SignPath | **To do:** turn on 2FA at github.com/settings/security |
| Builds from CI only, with manual approval of each signing request | Done: [release workflow](.github/workflows/release.yml) |

Then apply at <https://signpath.org/apply> with the repository URL.

## 2. Configure SignPath (after approval)

In the SignPath organization you are given:

1. **Project** with slug `agilos`, linked to this GitHub repository as a trusted build
   system (GitHub Actions).
2. **Artifact configurations:**
   - slug `app`:
     ```xml
     <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
       <zip-file>
         <pe-file path="Agilos.exe" product-name="Agilos">
           <authenticode-sign/>
         </pe-file>
       </zip-file>
     </artifact-configuration>
     ```
   - slug `installer`:
     ```xml
     <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
       <zip-file>
         <pe-file path="Agilos-Setup.exe" product-name="Agilos">
           <authenticode-sign/>
         </pe-file>
       </zip-file>
     </artifact-configuration>
     ```
3. **Signing policy** with slug `release-signing`, using the SignPath Foundation
   certificate, with the owner as approver.
4. An **API token** for a CI user that may submit to that policy.

## 3. Connect GitHub (after approval)

In the repository settings:

- Secret `SIGNPATH_API_TOKEN`: the API token.
- Variable `SIGNPATH_ORGANIZATION_ID`: the organization ID.

The next `v*` tag then builds the app, sends `Agilos.exe` for signing, builds the
installer around the signed app, sends the installer for signing, and publishes both
with a `latest.yml` recomputed for the signed file (`scripts/latest-yml.mjs`). Each
signing request waits for your approval in SignPath (up to an hour).
