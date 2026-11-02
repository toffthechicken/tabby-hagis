@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
set "SELF=%~f0"
title hagis by tabby  -  제거

for /f %%a in ('echo prompt $E^| cmd') do set "ESC=%%a"
set "C0=%ESC%[0m"
set "B=%ESC%[1m"
set "DIM=%ESC%[90m"
set "LIME=%ESC%[38;2;198;255;0m"
set "CYAN=%ESC%[38;2;0;240;255m"
set "YEL=%ESC%[38;2;255;215;0m"
set "G1=%ESC%[38;2;198;255;0m"
set "G2=%ESC%[38;2;158;255;51m"
set "G3=%ESC%[38;2;119;252;102m"
set "G4=%ESC%[38;2;79;249;153m"
set "G5=%ESC%[38;2;40;246;204m"
set "G6=%ESC%[38;2;0;240;255m"
if defined WT_SESSION (set "ART=B" & set "OK=✔") else (set "ART=A" & set "OK=OK")

set "TARGET=%APPDATA%\tabby\plugins\node_modules\tabby-hagis"

echo.
set /a "_n=0"
for /f "delims=" %%l in ('findstr /b /c:":::%ART%" "%SELF%"') do (
    set "_l=%%l"
    set /a "_n+=1"
    for %%c in (!_n!) do echo(    !G%%c!!_l:~4!%C0%
)
echo.
echo          %DIM%made by%C0%  %LIME%%B%JakeandToff%C0%   %DIM%·%C0%   %CYAN%instagram @toomuchthought.kr%C0%
echo.

if not exist "%TARGET%" (
    echo    %DIM%hagis 가 설치되어 있지 않습니다.%C0%
    echo.
    pause
    exit /b 0
)

echo    hagis 플러그인을 제거합니다.
echo    %DIM%저장한 워크스페이스·설정은 Tabby 설정 파일에 남아 있어, 다시 설치하면 그대로 돌아옵니다.%C0%
echo.
choice /c YN /n /m "   계속할까요? [Y/N] "
if errorlevel 2 (
    echo    취소했습니다.
    echo.
    pause
    exit /b 0
)

rmdir /s /q "%TARGET%"
echo.
echo    %LIME%%B%%OK% 제거 완료%C0%  Tabby 를 다시 시작하면 적용됩니다.
echo.
echo    %DIM%hagis by tabby  ·  made by%C0% %LIME%JakeandToff%C0%  %DIM%·%C0%  %CYAN%@toomuchthought.kr%C0%
echo.
pause
exit /b 0

:::B ██╗  ██╗ █████╗  ██████╗ ██╗███████╗
:::B ██║  ██║██╔══██╗██╔════╝ ██║██╔════╝
:::B ███████║███████║██║  ███╗██║███████╗
:::B ██╔══██║██╔══██║██║   ██║██║╚════██║
:::B ██║  ██║██║  ██║╚██████╔╝██║███████║
:::B ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝╚══════╝
:::A  _   _    _    ____ ___ ____
:::A | | | |  / \  / ___|_ _/ ___|
:::A | |_| | / _ \| |  _ | |\___ \
:::A |  _  |/ ___ \ |_| || | ___) |
:::A |_| |_/_/   \_\____|___|____/
