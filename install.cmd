@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "SELF=%~f0"
title hagis by tabby  -  made by JakeandToff

rem ---- 색(Windows 10 이상 콘솔) / 같은 줄 덮어쓰기용 CR
for /f %%a in ('echo prompt $E^| cmd') do set "ESC=%%a"
rem   CR: taken from "copy /Z" output; uses cmd.exe because /Z fails on OneDrive files
for /f %%a in ('copy /Z "%ComSpec%" nul 2^>nul') do set "CR=%%a"
set "C0=%ESC%[0m"
set "B=%ESC%[1m"
set "DIM=%ESC%[90m"
set "LIME=%ESC%[38;2;198;255;0m"
set "CYAN=%ESC%[38;2;0;240;255m"
set "RED=%ESC%[38;2;255;95;95m"
set "YEL=%ESC%[38;2;255;215;0m"
set "G1=%ESC%[38;2;198;255;0m"
set "G2=%ESC%[38;2;158;255;51m"
set "G3=%ESC%[38;2;119;252;102m"
set "G4=%ESC%[38;2;79;249;153m"
set "G5=%ESC%[38;2;40;246;204m"
set "G6=%ESC%[38;2;0;240;255m"

rem ---- Windows Terminal 이면 블록 글자, 옛 콘솔은 글자 폭이 달라 깨지므로 일반 문자
if defined WT_SESSION (
    set "ART=B" & set "ON=█" & set "OFF=░" & set "OK=✔" & set "NG=✘" & set "DOTS=…" & set "HR=────────────"
) else (
    set "ART=A" & set "ON=#" & set "OFF=." & set "OK=OK" & set "NG=X" & set "DOTS=..." & set "HR=------------"
)
set "HRL=!HR!!HR!!HR!!HR!!HR:~0,10!"

set "TARGET=%APPDATA%\tabby\plugins\node_modules\tabby-hagis"
set "LOG=%TEMP%\hagis-install.log"
set "HAGIS_REPO=toffthechicken/tabby-hagis"
rem   HAGIS_URL 로 내려받을 릴리스 zip 주소를 바꿀 수 있다 (사내 미러·테스트용)
if not defined HAGIS_URL set "HAGIS_URL=https://github.com/%HAGIS_REPO%/releases/latest/download/hagis.zip"
set "SRC=."
set "PCT=0"
if exist "%LOG%" del "%LOG%" >nul 2>nul

call :banner
call :check_tabby

if exist "src" goto source
if exist "dist\index.js" goto packaged
goto download

rem ================================================================ 배포용 zip — 빌드된 dist 를 그대로 설치
:packaged
set "TOTAL=2"
call :begin 1 "파일 확인      "
if not exist "dist\index.js" (
    set "MSG=dist\index.js 가 없습니다. 압축을 모두 푼 폴더에서 실행하세요."
    goto fail
)
call :done 1 "파일 확인      " 50 ok
call :install 2
if errorlevel 1 goto fail
goto finish

rem ================================================================ 소스 폴더 — 패키지 설치 → 빌드 → 설치
:source
set "TOTAL=4"
call :begin 1 "환경 확인      "
where node >nul 2>nul
if errorlevel 1 goto no_node
call :done 1 "환경 확인      " 25 ok

call :begin 2 "패키지 설치    "
if exist "node_modules" goto deps_ready
call npm install --no-audit --no-fund >"%LOG%" 2>&1
if errorlevel 1 (
    set "MSG=패키지 설치에 실패했습니다."
    goto fail
)
call :done 2 "패키지 설치    " 50 ok
goto build
:deps_ready
call :done 2 "패키지 설치    " 50 skip

:build
call :begin 3 "빌드           "
call npm run build --silent >"%LOG%" 2>&1
if errorlevel 1 (
    set "MSG=빌드에 실패했습니다."
    goto fail
)
call :done 3 "빌드           " 75 ok
call :install 4
if errorlevel 1 goto fail
goto finish

:no_node
if not exist "dist\index.js" goto fetch_release
call :done 1 "환경 확인      " 25 skip
echo    %YEL%Node.js 가 없어 빌드는 건너뛰고 들어 있는 dist 를 설치합니다.%C0%
call :begin 2 "패키지 설치    "
call :done 2 "패키지 설치    " 50 skip
call :begin 3 "빌드           "
call :done 3 "빌드           " 75 skip
call :install 4
if errorlevel 1 goto fail
goto finish

rem ================================================================ 릴리스 zip 내려받기 (깡통 PC — Node.js·git 없이 curl/tar 만으로)
:fetch_release
echo.
echo    %YEL%Node.js 가 없어서 빌드하지 않고, 빌드된 릴리스를 내려받아 설치합니다.%C0%
set "FROM_SOURCE=1"
:download
set "TOTAL=3"
set "PCT=0"
set "DL=%TEMP%\hagis-dl-%RANDOM%"
mkdir "%DL%" >nul 2>nul
call :begin 1 "내려받기      "
if exist "%SystemRoot%\System32\curl.exe" (
    "%SystemRoot%\System32\curl.exe" -fsSL --retry 2 --connect-timeout 15 -o "%DL%\hagis.zip" "%HAGIS_URL%" >"%LOG%" 2>&1
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri $env:HAGIS_URL -OutFile '%DL%\hagis.zip'" >"%LOG%" 2>&1
)
if errorlevel 1 goto download_failed
call :done 1 "내려받기      " 33 ok

call :begin 2 "압축 풀기      "
set "SRC="
if exist "%SystemRoot%\System32\tar.exe" (
    mkdir "%DL%\x" >nul 2>nul
    "%SystemRoot%\System32\tar.exe" -xf "%DL%\hagis.zip" -C "%DL%\x" >>"%LOG%" 2>&1
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%DL%\hagis.zip' -DestinationPath '%DL%\x' -Force" >>"%LOG%" 2>&1
)
if errorlevel 1 goto download_failed
if exist "%DL%\x\dist\index.js" set "SRC=%DL%\x"
for /d %%d in ("%DL%\x\*") do if exist "%%d\dist\index.js" set "SRC=%%d"
if not defined SRC goto download_failed
call :done 2 "압축 풀기      " 66 ok

call :install 3
if errorlevel 1 goto fail
rmdir /s /q "%DL%" >nul 2>nul
goto finish

:download_failed
echo.
echo.
if defined FROM_SOURCE goto offer_node
set "MSG=릴리스를 내려받지 못했습니다. 인터넷 연결을 확인하거나 https://github.com/%HAGIS_REPO%/releases 에서 zip 을 직접 받으세요."
goto fail

rem 릴리스도 없고 Node.js 도 없을 때 — winget 으로 Node.js LTS 를 설치하고 이 소스에서 직접 빌드한다
:offer_node
echo    %YEL%릴리스를 내려받지 못했습니다.%C0%  %DIM%아직 릴리스가 없거나 인터넷에 연결되지 않았습니다.%C0%
where winget >nul 2>nul
if errorlevel 1 (
    set "MSG=Node.js LTS 를 https://nodejs.org 에서 설치한 뒤 다시 실행하거나, 인터넷 연결 후 다시 시도하세요."
    goto fail
)
echo    Node.js 를 설치하면 이 소스에서 직접 빌드해 설치할 수 있습니다.
echo.
choice /c YN /n /m "   winget 으로 Node.js LTS 를 설치할까요? [Y/N] "
if errorlevel 2 (
    set "MSG=Node.js 나 릴리스 없이는 설치할 수 없습니다."
    goto fail
)
echo.
call winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
    set "MSG=Node.js 설치를 확인하지 못했습니다. 새 창을 열어 install.cmd 를 다시 실행해 보세요."
    goto fail
)
set "FROM_SOURCE="
set "PCT=0"
echo.
goto source

rem ================================================================ 끝
:finish
echo.
echo    %LIME%%B%%OK% 설치 완료%C0%  %DIM%→ %TARGET%%C0%
tasklist /fi "imagename eq Tabby.exe" 2>nul | find /i "Tabby.exe" >nul
if errorlevel 1 (
    echo    Tabby 를 실행하면 적용됩니다.
) else (
    echo    %YEL%Tabby 가 실행 중입니다.%C0% 완전히 종료했다가 다시 켜면 적용됩니다.
)
call :footer
pause
exit /b 0

:fail
echo.
echo.
echo    %RED%%B%%NG% 설치하지 못했습니다%C0%  %MSG%
if exist "%LOG%" echo    %DIM%자세한 내용: %LOG%%C0%
call :footer
pause
exit /b 1

rem Tabby 가 없으면 설치를 권한다 (winget 의 Eugeny.Tabby — 이름이 같은 TabbyML.Tabby 는 다른 프로그램)
:check_tabby
set "TABBY_EXE="
if exist "%LOCALAPPDATA%\Programs\Tabby\Tabby.exe" set "TABBY_EXE=%LOCALAPPDATA%\Programs\Tabby\Tabby.exe"
if not defined TABBY_EXE if exist "%ProgramFiles%\Tabby\Tabby.exe" set "TABBY_EXE=%ProgramFiles%\Tabby\Tabby.exe"
if defined TABBY_EXE exit /b 0
echo    %YEL%Tabby 가 설치되어 있지 않습니다.%C0%  %DIM%Tabby was not found.%C0%
echo    hagis 는 Tabby 플러그인이라 Tabby 가 먼저 있어야 동작합니다.
where winget >nul 2>nul
if errorlevel 1 goto tabby_manual
echo.
choice /c YNO /n /m "   Tabby 를 지금 설치할까요? [Y 설치 / N 건너뛰기 / O 다운로드 페이지 열기] "
if errorlevel 3 goto tabby_open
if errorlevel 2 goto tabby_skip
echo.
call winget install --id Eugeny.Tabby -e --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
    echo    %YEL%Tabby 설치를 마치지 못했습니다.%C0% 아래 주소에서 직접 설치하세요.
    goto tabby_manual
)
echo.
exit /b 0
:tabby_open
start "" "https://github.com/Eugeny/tabby/releases/latest"
echo    %DIM%Tabby 를 설치한 뒤 이 창에서 계속합니다. 플러그인은 지금 함께 설치해 둡니다.%C0%
echo.
exit /b 0
:tabby_manual
echo    %DIM%https://github.com/Eugeny/tabby/releases/latest%C0%
echo.
exit /b 0
:tabby_skip
echo    %DIM%건너뜁니다. 플러그인만 설치합니다.%C0%
echo.
exit /b 0

rem ================================================================ 화면 그리기

:banner
echo.
set /a "_n=0"
for /f "delims=" %%l in ('findstr /b /c:":::%ART%" "%SELF%"') do (
    set "_l=%%l"
    set /a "_n+=1"
    for %%c in (!_n!) do echo(    !G%%c!!_l:~4!%C0%
)
echo.
echo          %DIM%!HR!%C0%   %B%hagis%C0% %DIM%by tabby%C0%   %DIM%!HR!%C0%
echo                       %LIME%%B%H%C0%%DIM%ub for%C0% %LIME%%B%A%C0%%DIM%ll%C0% %LIME%%B%G%C0%%DIM%ear,%C0% %LIME%%B%I%C0%%DIM%n%C0% %LIME%%B%S%C0%%DIM%ight%C0%
echo          %DIM%made by%C0%  %LIME%%B%JakeandToff%C0%   %DIM%·%C0%   %CYAN%instagram @toomuchthought.kr%C0%
echo.
exit /b 0

:footer
echo.
echo    %DIM%!HRL!%C0%
echo    %DIM%hagis by tabby  ·  made by%C0% %LIME%JakeandToff%C0%  %DIM%·%C0%  %CYAN%@toomuchthought.kr%C0%
echo.
exit /b 0

rem 단계 시작: 지금까지의 진행 막대 + "…"
:begin
call :draw %1 %2 !PCT! "%DIM%%DOTS%%C0%"
exit /b 0

rem 단계 끝: 목표 %% 까지 막대를 채우는 애니메이션 + 결과 표시
:done
for /l %%p in (!PCT!,3,%~3) do (
    call :draw %1 %2 %%p "%DIM%%DOTS%%C0%"
    for /l %%z in (1,1,1200) do set "_z="
)
set "PCT=%~3"
if /i "%~4"=="skip" (
    call :draw %1 %2 %~3 "%DIM%건너뜀%C0%"
) else (
    call :draw %1 %2 %~3 "%LIME%%OK%%C0%"
)
echo.
exit /b 0

rem 한 줄 그리기: [단계/전체] 이름 막대 %% 상태 (같은 줄을 덮어쓴다)
:draw
set /a "_f=%~3*24/100"
set "_bar="
for /l %%i in (1,1,24) do if %%i leq !_f! (set "_bar=!_bar!!ON!") else (set "_bar=!_bar!!OFF!")
set "_p=  %~3"
set "_p=!_p:~-3!"
rem   set /p strips leading spaces/CR: start with a color code, put CR at the end
<nul set /p "=%C0%   %DIM%[%~1/!TOTAL!]%C0%  %~2 %LIME%!_bar!%C0% %B%!_p!%%%C0%  %~4      !CR!"
exit /b 0

rem Tabby 플러그인 폴더에 복사
:install
call :begin %1 "Tabby 에 설치  "
if exist "%TARGET%" rmdir /s /q "%TARGET%"
mkdir "%TARGET%\dist" >nul 2>nul
copy /y "%SRC%\package.json" "%TARGET%\" >nul 2>>"%LOG%"
if errorlevel 1 (
    set "MSG=Tabby 플러그인 폴더에 복사하지 못했습니다."
    exit /b 1
)
xcopy /e /i /q /y "%SRC%\dist" "%TARGET%\dist" >nul 2>>"%LOG%"
if errorlevel 1 (
    set "MSG=Tabby 플러그인 폴더에 복사하지 못했습니다."
    exit /b 1
)
for %%f in (README.md LICENSE THIRD_PARTY_NOTICES.md) do if exist "%SRC%\%%f" copy /y "%SRC%\%%f" "%TARGET%\" >nul
call :done %1 "Tabby 에 설치  " 100 ok
exit /b 0

rem ================================================================ 로고 (아래 줄은 실행되지 않고 :banner 가 읽어서 그린다)
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
