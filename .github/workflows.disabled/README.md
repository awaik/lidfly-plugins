# GitHub Actions intentionally disabled

Сборка, тесты, подпись, notarization и проверка релизных файлов выполняются
локально. GitHub используется только для хранения исходников и загрузки уже
готовых файлов в GitHub Release через `gh release create` / `gh release upload`.

Не переносите workflow обратно в `.github/workflows/`: это снова включит
платные runners. Локальные команды описаны в `docs/INSTALLER-RELEASE.md`.
