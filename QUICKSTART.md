# Быстрый старт - Деплой за 5 минут

## Шаг 1: Создайте GitHub репозиторий (2 минуты)

```bash
# В папке проекта
git init
git add .
git commit -m "Kinemon Games v3.0 - Online Multiplayer"
```

Перейдите на https://github.com/new и создайте репозиторий `kinemon-games`

```bash
# Замените YOUR_USERNAME на ваш логин GitHub
git remote add origin https://github.com/YOUR_USERNAME/kinemon-games.git
git branch -M main
git push -u origin main
```

## Шаг 2: Деплой сервера на Render.com (2 минуты)

1. Перейдите на https://render.com
2. Войдите через GitHub
3. New + → Web Service
4. Выберите репозиторий `kinemon-games`
5. Настройки:
   - **Name**: `kinemon-games`
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
6. Create Web Service

**Скопируйте URL** (например: `https://kinemon-games.onrender.com`)

## Шаг 3: Обновите URL сервера в коде (1 минута)

Откройте файлы и замените `kinemon-games.onrender.com` на ваш URL:

**В `display.html` (строка 271):**
```javascript
const defaultServer = isLocalhost ? 'ws://localhost:8080' : 'wss://ВАШ-ПРОЕКТ.onrender.com';
```

**В `controller.html` (строка 273):**
```javascript
const defaultServer = isLocalhost ? 'ws://localhost:8080' : 'wss://ВАШ-ПРОЕКТ.onrender.com';
```

Затем:
```bash
git add .
git commit -m "Update server URL"
git push
```

## Шаг 4: Деплой HTML на GitHub Pages (1 минута)

1. В GitHub репозитории: **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: **main** → папка **/ (root)**
4. Save

Через 2 минуты сайт будет доступен:
```
https://YOUR_USERNAME.github.io/kinemon-games/
```

## Готово! Как играть:

### На компьютере:
Откройте: `https://YOUR_USERNAME.github.io/kinemon-games/display.html`

### На телефоне:
1. Откройте камеру телефона
2. Наведите на QR-код с экрана компьютера
3. Нажмите на уведомление
4. Автоматически откроется controller.html!

---

## Альтернатива: Без GitHub Pages

Если не хотите использовать GitHub Pages, можно открывать файлы напрямую:

1. **Display (компьютер)**: Откройте `display.html` прямо из папки проекта в браузере
2. **Controller (телефон)**: Загрузите папку проекта на телефон и откройте `controller.html`

Но тогда не будет работать сканирование QR-кода камерой (нужен HTTPS).

---

## Проверка работы

✅ Сервер запущен: `https://ваш-проект.onrender.com` показывает index.html
✅ Display работает: видите QR-код и код комнаты
✅ Controller работает: можете подключиться и пройти калибровку
✅ QR сканируется: камера распознает код и открывает ссылку

**Важно**: При первом подключении Render может занять 30-60 секунд (сервер просыпается).
