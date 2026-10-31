# Release policy

Every completed IMB — Infinite Media Board version must follow these rules:

1. Preserve the version in its own `release-vX.Y.Z-*` directory.
2. Build the matching portable ZIP without deleting older versions.
3. Run `tools/update-start-menu-shortcut.ps1` with the new executable and version. It always replaces the original files inside the stable `current\win-unpacked` location. If that executable is running, the script automatically waits in the background and replaces it immediately after the app exits.
4. Keep the Start Menu shortcut named `IMB.lnk` pointed to the stable `current` executable. Maintain the legacy shortcut only as a compatibility redirect.
5. Keep one desktop shortcut named `IMB.lnk`, pointed to the same stable `current` executable. Never delete it during an update.
6. Never point either shortcut at a versioned release directory. The update script preserves the stable executable path, so the desktop shortcut and an existing pinned Start entry always resolve to the newest version.

Example:

```powershell
.\tools\update-start-menu-shortcut.ps1 `
  -LatestExe '.\release\win-unpacked\IMB.exe' `
  -Version '0.10.0'
```
