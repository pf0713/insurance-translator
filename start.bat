@echo off
echo ========================================
echo   保险条款翻译器
echo ========================================
echo.
echo [1/2] 自动检测本机IP地址...
node tunnel.js
echo [2/2] 启动后端...
start "后端" cmd /c "node server.js"
timeout /t 2 /nobreak >nul
echo.
echo ========================================
echo   后端已启动！
echo   手机和电脑连同一WiFi即可使用
echo   关闭命令行窗口停止服务
echo ========================================
pause
