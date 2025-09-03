# mts-vpbx-group-bot (ARM/Mac fix)

Сборка использует системный Chromium внутри контейнера (Debian bookworm), поэтому корректно работает на Apple Silicon (M1/M2).

## Шаги запуска
1) Скопируйте `bot/.env.example` → `bot/.env` и заполните:
   TELEGRAM_TOKEN, ADMIN_CHAT_ID, MTS_LOGIN, MTS_PASSWORD, GROUP_NAME

2) Запустите:
   docker compose up -d --build

3) Команды:
   /help, /status, /set preset <day|night|full|reserve>, /reserve, /set members <..;..>, /clear
