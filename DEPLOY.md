# Деплой PolyBot на VPS (Лондон)

## Шаг 1 — Подключение к VPS

```bash
ssh root@<VPS_IP>
```

---

## Шаг 2 — Установка Node.js 20 и PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git
npm install -g pm2
```

Проверка:
```bash
node -v   # должно быть v20.x.x
npm -v
```

---

## Шаг 3 — Клонирование репозитория

```bash
git clone https://github.com/Mirado97/Krispo.git polybot
cd polybot
```

---

## Шаг 4 — Установка зависимостей и сборка

```bash
npm ci
npm run build
```

Если сборка прошла без ошибок — в папке `dist/` появятся скомпилированные файлы.

---

## Шаг 5 — Создание .env

```bash
cp .env.example .env
nano .env
```

### Для DRY_RUN симуляции (запустить сначала):

```
DRY_RUN=true
MARKET_STRATEGY=btc-15min

# Кошелёк и API не нужны в симуляции — оставить пустыми
PRIVATE_KEY=
WALLET_ADDRESS=
PROXY_ADDRESS=
POLY_API_KEY=
POLY_API_SECRET=
POLY_API_PASSPHRASE=

# Параметры оставить как в .env.example
```

### Для live торговли (после валидации симуляции):

```
DRY_RUN=false
PRIVATE_KEY=0x<приватный ключ кошелька>
WALLET_ADDRESS=0x<адрес кошелька>
PROXY_ADDRESS=0x<адрес Gnosis Safe>
POLY_API_KEY=<ключ>
POLY_API_SECRET=<секрет>
POLY_API_PASSPHRASE=<фраза>
MARKET_STRATEGY=btc-15min

# Ограничения для фазы 9 ($50 капитал)
ORDER_SIZE=5
TAKER_SIZE=5
CTF_SPLIT_SIZE=5
DAILY_SPEND_CAP=20
MAX_LOSS=50
MAX_POSITION=100
MAX_NOTIONAL=200
```

---

## Шаг 6 — Генерация CLOB ключей (только для live)

```bash
npm run generate-keys
```

Вставить вывод в `.env`: `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE`.

---

## Шаг 7 — Запуск

### Сначала — тест симуляции (запустить руками, смотреть логи):

```bash
node dist/index.js
```

Что должно быть в логах:
- `Market rotation triggered` — нашёл рынок btc-15min
- `Configuration loaded` — стратегия и параметры
- `[DRY_RUN] would place...` — ордера симулируются
- `fair value` числа около 0.4–0.6

Если всё выглядит нормально — Ctrl+C и запускаем через PM2.

### Запуск через PM2 (для постоянной работы):

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # скопировать и выполнить команду которую выдаст
```

---

## Шаг 8 — Мониторинг

```bash
pm2 logs polybot          # live логи
pm2 monit                 # CPU и RAM
pm2 status                # статус процессов
```

Остановить:
```bash
pm2 stop polybot
```

Перезапустить после изменения .env:
```bash
pm2 restart polybot
```

---

## Шаг 9 — Обновление кода с GitHub

```bash
cd ~/polybot
git pull
npm ci
npm run build
pm2 restart polybot
```

---

## Порядок фазы 9 (live, $50)

1. Создать **отдельный** кошелёк (не основной!) — Metamask или cast wallet generate
2. Перевести **50 USDC** на этот кошелёк в сети Polygon
3. Создать **Gnosis Safe** на app.safe.global с этим кошельком → скопировать адрес Safe в `PROXY_ADDRESS`
4. Сгенерировать CLOB ключи: `npm run generate-keys`
5. Заполнить `.env` реальными данными (параметры фазы 9 — см. Шаг 5)
6. Переключить `DRY_RUN=false`
7. Запустить и наблюдать 3 дня
8. После валидации — фаза 10 (масштабирование, больший капитал)

---

## Важно

- `.env` **никогда** не коммитить в git (уже в .gitignore)
- Приватный ключ хранить только в `.env` на сервере
- В фазе 9 использовать **отдельный** кошелёк, не тот где основные средства
