@echo off
chcp 65001 >nul
title 단어 연결 게임 - 멀티플레이 서버
setlocal

rem ------------------------------------------------------------------
rem  단어 연결 게임 멀티플레이 서버를 켜는 스크립트.
rem  이 파일을 더블클릭하면 서버가 뜨고, 브라우저에 게임 화면이 열립니다.
rem  명령어를 따로 칠 필요가 없도록 준비(라이브러리 설치)까지 알아서 합니다.
rem ------------------------------------------------------------------

set "ROOT=%~dp0"
set "NODE_DIR=%ROOT%tools\node"
set "SERVER_DIR=%ROOT%server"

echo.
echo   === 단어 연결 게임 - 멀티플레이 서버 ===
echo.

rem 1) 어떤 Node 로 켤지 고른다. 프로젝트 안 tools\node 를 먼저 쓰고, 없으면 PC에 설치된 것을 쓴다.
if exist "%NODE_DIR%\node.exe" goto :node_local
where node >nul 2>nul && goto :node_system
goto :node_missing

:node_local
set "PATH=%NODE_DIR%;%PATH%"
goto :deps

:node_system
goto :deps

:node_missing
echo   [문제] Node.js 를 찾지 못했습니다.
echo.
echo   이 프로젝트는 tools\node 폴더에 들어 있는 Node.js 로 서버를 켭니다.
echo   그 폴더가 지워졌거나 옮겨졌다면, 아래 주소에서 Windows 64-bit ZIP 을 받아
echo   압축을 푼 뒤 폴더 이름을 node 로 바꿔 tools\node 가 되게 넣어주세요.
echo.
echo       https://nodejs.org/ko/download
echo.
pause
exit /b 1

rem 2) 처음 한 번은 서버가 쓰는 라이브러리를 내려받아야 한다.
:deps
cd /d "%SERVER_DIR%"
if exist "node_modules" goto :run
echo   처음 실행이라 필요한 파일을 내려받습니다. 1~2분 걸릴 수 있어요...
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto :deps_failed
echo.
goto :run

:deps_failed
echo.
echo   [문제] 필요한 파일을 내려받지 못했습니다. 인터넷 연결을 확인한 뒤 다시 실행해주세요.
echo.
pause
exit /b 1

rem 3) 서버를 켜고, 잠시 뒤 브라우저에 게임 화면을 띄운다.
:run
start "" /min cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node src\server.js

echo.
echo   서버가 종료되었습니다. 다시 하려면 이 파일을 또 실행하세요.
pause
