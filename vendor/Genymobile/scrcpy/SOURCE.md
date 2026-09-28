# scrcpy-server.jar

Device-side server started by ws-scrcpy (`SERVER_VERSION` in `src/common/Constants.ts`).

- Version: `4.1-ws1` (scrcpy 4.1 plus a WebSocket front end for ws-scrcpy, with audio)
- Source: https://github.com/rjanja/scrcpy, branch `ws-scrcpy`, commit `f81494a7e05ba237f70bce37fec7a6a91f0cde9d`
  (based on Genymobile/scrcpy tag `v4.1`; the changes are in `server/src/main/java/com/genymobile/scrcpy/ws/`)
- SHA-256: `fcc66e7bdbd24b9753754f4e67e63f5efc6c60176b2a50c7a25a48aa215624cc`

## Rebuild

With the Android SDK (platform 36, build-tools 36.0.0) and a JDK 17:

```bash
cd scrcpy && ANDROID_HOME=~/Library/Android/sdk BUILD_DIR=build_ws ./server/build_without_gradle.sh
cp build_ws/scrcpy-server <ws-scrcpy>/vendor/Genymobile/scrcpy/scrcpy-server.jar
```

The build is not bit-for-bit reproducible (javac/d8 embed timestamps), so compare behaviour, not hashes.
