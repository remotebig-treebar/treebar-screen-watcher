; installer.nsh — custom NSIS script สำหรับ Treebar Screen Watcher
; electron-builder จะ include ไฟล์นี้โดยอัตโนมัติ

; แสดงหน้า license agreement
!define MUI_LICENSEPAGE_TEXT_TOP "กรุณาอ่านข้อตกลงการใช้งานก่อนติดตั้ง"

; ข้อความหน้า finish
!define MUI_FINISHPAGE_RUN "$INSTDIR\Treebar Screen Watcher.exe"
!define MUI_FINISHPAGE_RUN_TEXT "เปิด Treebar Screen Watcher ทันที"
