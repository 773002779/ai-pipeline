@echo off
chcp 65001 >nul
call "%~dp0stop.bat"
timeout /t 2 >nul
call "%~dp0start.bat"
