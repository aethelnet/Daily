#!/usr/bin/env bash
# Package a compiled Linux Daily binary into:
#   - daily_<version>_amd64.deb      (Ubuntu / Debian / Mint)
#   - daily-<version>-1.x86_64.rpm   (Fedora / Bazzite / openSUSE)
#   - daily-v<version>-linux-x86_64.tar.gz
set -euo pipefail

VERSION="${1:?Usage: build_linux_packages.sh <version> <binary-path> <out-dir>}"
BIN_PATH="$(readlink -f "${2:?Binary path required}")"
OUT_DIR="$(mkdir -p "${3:?Output dir required}" && readlink -f "$3")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -x "$BIN_PATH" ]]; then
  echo "Error: executable binary not found at $BIN_PATH" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. Portable Linux tarball
TAR_ROOT="$TMP/daily-v${VERSION}-linux-x86_64"
mkdir -p "$TAR_ROOT"
cp "$BIN_PATH" "$TAR_ROOT/daily"
chmod 0755 "$TAR_ROOT/daily"
cp "$ROOT/README.md" "$ROOT/LICENSE" "$ROOT/packaging/linux/network.aethelburg.daily.desktop" "$TAR_ROOT/"
tar -C "$TMP" -czf "$OUT_DIR/daily-v${VERSION}-linux-x86_64.tar.gz" "daily-v${VERSION}-linux-x86_64"
echo "Built $OUT_DIR/daily-v${VERSION}-linux-x86_64.tar.gz"

# 2. Debian / Ubuntu .deb package (zero external Python dependencies)
if command -v dpkg-deb >/dev/null 2>&1; then
  DEB_ROOT="$TMP/deb"
  mkdir -p \
    "$DEB_ROOT/DEBIAN" \
    "$DEB_ROOT/usr/bin" \
    "$DEB_ROOT/usr/share/applications" \
    "$DEB_ROOT/usr/share/metainfo" \
    "$DEB_ROOT/usr/share/icons/hicolor/scalable/apps" \
    "$DEB_ROOT/usr/share/icons/hicolor/512x512/apps"

  install -m 0755 "$BIN_PATH" "$DEB_ROOT/usr/bin/daily"
  install -m 0644 "$ROOT/packaging/linux/network.aethelburg.daily.desktop" \
    "$DEB_ROOT/usr/share/applications/network.aethelburg.daily.desktop"
  install -m 0644 "$ROOT/packaging/linux/network.aethelburg.daily.metainfo.xml" \
    "$DEB_ROOT/usr/share/metainfo/network.aethelburg.daily.metainfo.xml"
  install -m 0644 "$ROOT/static/icon.svg" \
    "$DEB_ROOT/usr/share/icons/hicolor/scalable/apps/network.aethelburg.daily.svg"
  install -m 0644 "$ROOT/static/icon-512.png" \
    "$DEB_ROOT/usr/share/icons/hicolor/512x512/apps/network.aethelburg.daily.png"

  INSTALLED_KB=$(du -sk "$DEB_ROOT/usr" | awk '{print $1}')
  cat > "$DEB_ROOT/DEBIAN/control" <<EOF
Package: daily
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: amd64
Installed-Size: ${INSTALLED_KB}
Depends: libc6
Maintainer: Niklas Herlyn <nika.hrlyn@gmail.com>
Homepage: https://daily.aethelburg.network
Description: Local-first signed-graph habit tracker & rhythm observer
 Daily is a calm, zero-cloud habit and daily-rhythm tracker featuring
 signed (+/-) live graph routing, Continuous-Time Liquid Relaxation ODE,
 offline tabular AI insights, and AES-256-GCM end-to-end encrypted sync.
EOF

  dpkg-deb --root-owner-group --build "$DEB_ROOT" "$OUT_DIR/daily_${VERSION}_amd64.deb"
  echo "Built $OUT_DIR/daily_${VERSION}_amd64.deb"
else
  echo "Skipping .deb (dpkg-deb not installed)"
fi

# 3. Fedora / Bazzite / openSUSE .rpm package (strip disabled to protect PyInstaller payload!)
if command -v rpmbuild >/dev/null 2>&1; then
  RPM_TOP="$TMP/rpmbuild"
  mkdir -p "$RPM_TOP"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
  cat > "$RPM_TOP/SPECS/daily.spec" <<EOF
%global _enable_debug_package 0
%global debug_package %{nil}
%global __os_install_post %{nil}
%global __strip /bin/true
%global _build_id_links none

Name:           daily
Version:        ${VERSION}
Release:        1
Summary:        Local-first signed-graph habit tracker & rhythm observer
License:        MIT
URL:            https://daily.aethelburg.network
AutoReqProv:    no

%description
Daily is a calm, zero-cloud habit and daily-rhythm tracker featuring
signed (+/-) live graph routing, Continuous-Time Liquid Relaxation ODE,
offline tabular AI insights, and AES-256-GCM end-to-end encrypted sync.

%install
install -Dm0755 ${BIN_PATH} %{buildroot}/usr/bin/daily
install -Dm0644 ${ROOT}/packaging/linux/network.aethelburg.daily.desktop %{buildroot}/usr/share/applications/network.aethelburg.daily.desktop
install -Dm0644 ${ROOT}/packaging/linux/network.aethelburg.daily.metainfo.xml %{buildroot}/usr/share/metainfo/network.aethelburg.daily.metainfo.xml
install -Dm0644 ${ROOT}/static/icon.svg %{buildroot}/usr/share/icons/hicolor/scalable/apps/network.aethelburg.daily.svg
install -Dm0644 ${ROOT}/static/icon-512.png %{buildroot}/usr/share/icons/hicolor/512x512/apps/network.aethelburg.daily.png

%files
/usr/bin/daily
/usr/share/applications/network.aethelburg.daily.desktop
/usr/share/metainfo/network.aethelburg.daily.metainfo.xml
/usr/share/icons/hicolor/scalable/apps/network.aethelburg.daily.svg
/usr/share/icons/hicolor/512x512/apps/network.aethelburg.daily.png
EOF

  rpmbuild --define "_topdir $RPM_TOP" --target x86_64 -bb "$RPM_TOP/SPECS/daily.spec"
  cp "$RPM_TOP/RPMS/x86_64/daily-${VERSION}-1.x86_64.rpm" "$OUT_DIR/"
  echo "Built $OUT_DIR/daily-${VERSION}-1.x86_64.rpm"
else
  echo "Skipping .rpm (rpmbuild not installed)"
fi
