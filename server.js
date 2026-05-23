const express = require('express');
const app = express();
const db = require('./database');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const bodyParser = require('body-parser');
const multer = require('multer');

// --- 1. DIRECTORY & DATABASE AUTO-SETUP ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

db.serialize(() => {
    db.all("PRAGMA table_info(users)", (err, columns) => {
        if (err) return console.error("Migration Error:", err);
        const colNames = columns.map(c => c.name);
        
        // Auto-fix: Profile Picture column
        if (!colNames.includes('profile_picture_url')) {
            console.log("Adding profile_picture_url...");
            db.run("ALTER TABLE users ADD COLUMN profile_picture_url TEXT");
        }
        // Auto-fix: Face AI Descriptor column
        if (!colNames.includes('face_descriptor')) {
            console.log("Adding face_descriptor...");
            db.run("ALTER TABLE users ADD COLUMN face_descriptor TEXT");
        }
        if (!colNames.includes('is_keyholder')) {
            console.log("Adding is_keyholder...");
            db.run("ALTER TABLE users ADD COLUMN is_keyholder INTEGER DEFAULT 0");
        }
    });
});

// --- 2. STORAGE CONFIGURATION ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const userId = req.body.userId || 'unknown';
        cb(null, `profile-${userId}-${Date.now()}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage: storage });

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const AUTH_USERNAME = process.env.APP_LOGIN_USERNAME || 'admin';
const AUTH_PASSWORD = process.env.APP_LOGIN_PASSWORD || 'change-this-password';
const AUTH_COOKIE_NAME = 'attendance_auth';
const AUTH_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const authSessions = new Map();

const parseCookies = (cookieHeader) => String(cookieHeader || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex === -1) return cookies;
        const key = part.slice(0, separatorIndex).trim();
        const value = part.slice(separatorIndex + 1).trim();
        cookies[key] = decodeURIComponent(value);
        return cookies;
    }, {});

const sanitizeNextPath = (value) => {
    const nextPath = String(value || '/');
    if (!nextPath.startsWith('/') || nextPath.startsWith('//')) return '/';
    return nextPath;
};

const timingSafeEqualString = (left, right) => {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const createAuthCookie = (token, maxAgeSeconds) => {
    const cookieParts = [
        `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAgeSeconds}`
    ];
    return cookieParts.join('; ');
};

const getAuthSession = (req) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[AUTH_COOKIE_NAME];
    if (!token) return null;

    const session = authSessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        authSessions.delete(token);
        return null;
    }

    return session;
};

// --- 3. MIDDLEWARE ---
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
    const publicPaths = new Set(['/login', '/login.html', '/logout', '/favicon.ico']);
    if (publicPaths.has(req.path)) return next();

    const session = getAuthSession(req);
    if (session) {
        req.authUser = session.username;
        return next();
    }

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required.' });
    }

    const nextPath = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/login?next=${nextPath}`);
});
app.use(express.static(path.join(__dirname, '')));
app.use('/uploads', express.static(uploadDir));

const getMSTDateTime = (date = new Date()) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Denver',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(date).reduce((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
    }, {});

    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};

const getMSTDate = (date = new Date()) => getMSTDateTime(date).split(' ')[0];

const getNowInfo = () => {
    const now = new Date();
    return {
        date: getMSTDate(now),
        timestamp: getMSTDateTime(now),
        ms: now.getTime()
    };
};

const formatMinutes = (minutes) => {
    const total = Number(minutes) || 0;
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    if (hours === 0) return `${mins}m`;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
};

const getDayStatsSql = `
    SELECT u.*, 
           COALESCE(today.minutes, 0) AS today_minutes,
           COALESCE(total.minutes, 0) AS total_minutes
    FROM users u
    LEFT JOIN (
        SELECT s.user_id,
               SUM(CASE
                       WHEN s.invalidated = 1 THEN 0
                       WHEN s.checked_out_ms IS NULL THEN ROUND((? - s.checked_in_ms) / 60000.0)
                       ELSE s.duration_minutes
                   END) AS minutes
        FROM attendance_sessions s
        WHERE s.work_date = ?
        GROUP BY s.user_id
    ) today ON today.user_id = u.id
    LEFT JOIN (
        SELECT s.user_id,
               SUM(CASE
                       WHEN s.invalidated = 1 THEN 0
                       WHEN s.checked_out_ms IS NULL THEN ROUND((? - s.checked_in_ms) / 60000.0)
                       ELSE s.duration_minutes
                   END) AS minutes
        FROM attendance_sessions s
        GROUP BY s.user_id
    ) total ON total.user_id = u.id
    ORDER BY u.name ASC
`;

const closeOpenSession = (userId, nowInfo, options, callback) => {
    db.get(
        'SELECT id, checked_in_ms, work_date FROM attendance_sessions WHERE user_id = ? AND checked_out_ms IS NULL ORDER BY id DESC LIMIT 1',
        [userId],
        (err, session) => {
            if (err) return callback(err);
            if (!session) return callback(null);

            const durationMinutes = options.invalidateDay
                ? 0
                : Math.max(0, Math.round((nowInfo.ms - session.checked_in_ms) / 60000));

            db.run(
                'UPDATE attendance_sessions SET checked_out_at = ?, checked_out_ms = ?, duration_minutes = ?, invalidated = ?, invalidated_reason = ? WHERE id = ?',
                [
                    nowInfo.timestamp,
                    nowInfo.ms,
                    durationMinutes,
                    options.invalidateDay ? 1 : 0,
                    options.invalidateReason || null,
                    session.id
                ],
                callback
            );
        }
    );
};

const invalidateSessionsForDate = (userId, workDate, nowInfo, reason, callback) => {
    db.run(
        `UPDATE attendance_sessions
         SET invalidated = 1,
             invalidated_reason = ?,
             checked_out_at = COALESCE(checked_out_at, ?),
             checked_out_ms = COALESCE(checked_out_ms, ?),
             duration_minutes = 0
         WHERE user_id = ? AND work_date = ?`,
        [reason, nowInfo.timestamp, nowInfo.ms, userId, workDate],
        callback
    );
};

const finalizeCheckOut = (userId, options, res, done) => {
    const nowInfo = getNowInfo();
    const { invalidateDay = false, invalidateReason = null, action = 'check_out', status = 'checked_out' } = options;

    db.get('SELECT id, is_keyholder FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(404).send();

        db.run('UPDATE users SET status = ? WHERE id = ?', [status, userId], (updateErr) => {
            if (updateErr) return res.status(500).json({ error: updateErr.message });

            const onComplete = (sessionErr) => {
                if (sessionErr) return res.status(500).json({ error: sessionErr.message });

                db.run(
                    'INSERT INTO attendance_log (user_id, action, timestamp) VALUES (?, ?, ?)',
                    [userId, action, nowInfo.timestamp],
                    (logErr) => {
                        if (logErr) return res.status(500).json({ error: logErr.message });
                        if (done) return done(user, nowInfo);
                        res.json({ success: true, status });
                    }
                );
            };

            if (invalidateDay) {
                invalidateSessionsForDate(userId, nowInfo.date, nowInfo, invalidateReason, onComplete);
            } else {
                closeOpenSession(userId, nowInfo, { invalidateDay: false }, onComplete);
            }
        });
    });
};

const logAction = (userId, status, action, res) => {
    db.run('UPDATE users SET status = ? WHERE id = ?', [status, userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run('INSERT INTO attendance_log (user_id, action, timestamp) VALUES (?, ?, ?)', [userId, action, getMSTDateTime()], () => {
            const message = action === 'check_in'
                ? 'User checked in successfully.'
                : action === 'check_out'
                    ? 'User checked out successfully.'
                    : action === 'break_start'
                        ? 'Break started successfully.'
                        : 'Action completed successfully.';
            res.json({ success: true, status, message });
        });
    });
};

// --- 4. PAGE ROUTES ---
app.get(['/login', '/login.html'], (req, res) => {
    const session = getAuthSession(req);
    if (session) {
        return res.redirect(sanitizeNextPath(req.query.next));
    }

    res.sendFile(path.join(__dirname, 'login.html'));
});

app.all('/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[AUTH_COOKIE_NAME];
    if (token) authSessions.delete(token);
    res.setHeader('Set-Cookie', createAuthCookie('', 0));
    res.redirect('/login');
});

app.post('/login', (req, res) => {
    const username = String(req.body.username || '');
    const password = String(req.body.password || '');
    const nextPath = sanitizeNextPath(req.body.next || req.query.next);

    if (timingSafeEqualString(username, AUTH_USERNAME) && timingSafeEqualString(password, AUTH_PASSWORD)) {
        const token = crypto.randomBytes(32).toString('hex');
        authSessions.set(token, {
            username,
            expiresAt: Date.now() + AUTH_SESSION_TTL_MS
        });

        res.setHeader('Set-Cookie', createAuthCookie(token, Math.floor(AUTH_SESSION_TTL_MS / 1000)));
        return res.redirect(nextPath);
    }

    return res.redirect(`/login?error=1&next=${encodeURIComponent(nextPath)}`);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/tablet', (req, res) => res.sendFile(path.join(__dirname, 'ipad.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/upload', (req, res) => res.sendFile(path.join(__dirname, 'upload.html')));
app.get('/face-setup', (req, res) => res.sendFile(path.join(__dirname, 'face-setup.html')));

app.get('/admin/cards/all', (req, res) => {
    db.all('SELECT id, name, rfid_code, profile_picture_url FROM users ORDER BY name ASC', (err, users) => {
        if (err) return res.status(500).send(err.message);
        const safeUsers = (users || []).map(user => ({
            id: user.id,
            name: escapeHtml(user.name),
            rfid_code: escapeHtml(user.rfid_code),
            profile_picture_url: user.profile_picture_url ? escapeHtml(user.profile_picture_url) : '',
            initials: user.name ? escapeHtml(user.name).charAt(0).toUpperCase() : '?'
        }));

        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Print All Cards</title>
    <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
    <style>
        :root {
            --honey: #f7b733;
            --honey-dark: #d99000;
            --cream: #fff7e6;
            --ink: #1f1b16;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            padding: 20px;
            background:
                radial-gradient(circle at top left, rgba(247,183,51,0.18), transparent 30%),
                radial-gradient(circle at bottom right, rgba(255,200,61,0.15), transparent 25%),
                linear-gradient(135deg, #fffdf7 0%, #f7f2e7 55%, #fff7e6 100%);
            font-family: Arial, sans-serif;
            color: var(--ink);
        }
        .toolbar {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
            margin-bottom: 16px;
        }
        .toolbar button {
            border: none;
            background: var(--ink);
            color: white;
            border-radius: 999px;
            padding: 10px 16px;
            font-weight: 700;
            cursor: pointer;
        }
        .sheet {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(2.85in, 1fr));
            gap: 14px;
            align-items: start;
        }
        .card {
            width: 2.85in;
            height: 1.95in;
            border-radius: 18px;
            background: linear-gradient(135deg, rgba(255,255,255,0.95), rgba(255,247,230,0.96));
            border: 2px solid rgba(31,27,22,0.12);
            box-shadow: 0 18px 40px rgba(31,27,22,0.12);
            position: relative;
            overflow: hidden;
            padding: 10px;
            break-inside: avoid;
        }
        .card::before {
            content: '';
            position: absolute;
            top: -18px;
            right: -18px;
            width: 82px;
            height: 82px;
            border-radius: 50%;
            background: radial-gradient(circle, rgba(247,183,51,0.6) 0 22%, transparent 24%), radial-gradient(circle, rgba(31,27,22,0.07) 0 18%, transparent 20%);
            pointer-events: none;
        }
        .brand {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.62rem;
            font-weight: 800;
            letter-spacing: 0.22em;
            text-transform: uppercase;
            color: var(--honey-dark);
            margin-bottom: 8px;
        }
        .bee {
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: linear-gradient(90deg, #1f1b16 0 18%, #ffc83d 18% 34%, #1f1b16 34% 50%, #ffc83d 50% 66%, #1f1b16 66% 82%, #ffc83d 82% 100%);
        }
        .top {
            display: grid;
            grid-template-columns: 0.78in 1fr;
            gap: 8px;
            align-items: center;
        }
        .photo {
            width: 0.78in;
            height: 0.78in;
            border-radius: 14px;
            overflow: hidden;
            border: 3px solid var(--honey-dark);
            background: linear-gradient(180deg, #ffefb6, #f2c56b);
            display: grid;
            place-items: center;
            color: var(--ink);
            font-size: 24px;
            font-weight: 800;
        }
        .photo img { width: 100%; height: 100%; object-fit: cover; }
        .name {
            font-size: 0.82rem;
            font-weight: 800;
            line-height: 1.05;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-bottom: 3px;
        }
        .rfid-label {
            font-size: 0.52rem;
            font-weight: 800;
            letter-spacing: 0.14em;
            color: rgba(31,27,22,0.7);
            text-transform: uppercase;
        }
        .rfid-text {
            font-size: 0.56rem;
            letter-spacing: 0.18em;
            font-weight: 700;
            margin-top: 2px;
        }
        .barcode-wrap {
            margin-top: 7px;
            background: white;
            border-radius: 12px;
            padding: 5px 8px 3px;
            border: 1px solid rgba(31,27,22,0.08);
        }
        .barcode {
            width: 100%;
            height: 46px;
        }
        .footer-note {
            position: absolute;
            right: 10px;
            bottom: 8px;
            font-size: 0.5rem;
            letter-spacing: 0.14em;
            text-transform: uppercase;
            color: rgba(31,27,22,0.58);
        }
        @page { size: auto; margin: 0.25in; }
        @media print {
            body { padding: 0; background: white; }
            .toolbar { display: none; }
            .sheet { gap: 10px; }
            .card { box-shadow: none; }
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button onclick="window.print()">Print</button>
        <button onclick="window.close()">Close</button>
    </div>
    <div class="sheet">
        ${safeUsers.map(user => `
            <div class="card">
                <div class="brand"><span class="bee"></span><span>Hive Access</span></div>
                <div class="top">
                    <div class="photo">${user.profile_picture_url ? `<img src="${user.profile_picture_url}" alt="${user.name}">` : user.initials}</div>
                    <div>
                        <div class="name">${user.name}</div>
                        <div class="rfid-label">RFID</div>
                        <div class="rfid-text">${user.rfid_code}</div>
                    </div>
                </div>
                <div class="barcode-wrap">
                    <svg class="barcode" id="barcode-${user.id}"></svg>
                </div>
                <div class="footer-note">Bee themed access card</div>
            </div>
        `).join('')}
    </div>
    <script>
        const users = ${JSON.stringify(safeUsers.map(user => ({ id: user.id, rfid_code: user.rfid_code })))};
        if (window.JsBarcode) {
            users.forEach(user => {
                JsBarcode('#barcode-' + user.id, user.rfid_code || '', {
                    format: 'CODE128',
                    displayValue: false,
                    margin: 0,
                    height: 40,
                    width: 1.4
                });
            });
        }
    </script>
</body>
</html>
        `);
    });
});

app.get('/admin/cards/:userId', (req, res) => {
    db.get('SELECT id, name, rfid_code, profile_picture_url FROM users WHERE id = ?', [req.params.userId], (err, user) => {
        if (err) return res.status(500).send(err.message);
        if (!user) return res.status(404).send('User not found.');

        const safeName = escapeHtml(user.name);
        const safeRfid = escapeHtml(user.rfid_code);
        const photoUrl = user.profile_picture_url ? escapeHtml(user.profile_picture_url) : '';
        const initials = safeName ? safeName.charAt(0).toUpperCase() : '?';

        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Print Card - ${safeName}</title>
    <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
    <style>
        :root {
            --honey: #f7b733;
            --honey-dark: #d99000;
            --cream: #fff7e6;
            --ink: #1f1b16;
            --bee: #ffc83d;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background:
                radial-gradient(circle at top left, rgba(247,183,51,0.25), transparent 30%),
                radial-gradient(circle at bottom right, rgba(255,200,61,0.18), transparent 25%),
                linear-gradient(135deg, #fffdf7 0%, #f7f2e7 55%, #fff7e6 100%);
            font-family: Arial, sans-serif;
            color: var(--ink);
            padding: 24px;
        }
        .toolbar {
            position: fixed;
            top: 16px;
            right: 16px;
            display: flex;
            gap: 10px;
            z-index: 10;
        }
        .toolbar button {
            border: none;
            background: var(--ink);
            color: white;
            border-radius: 999px;
            padding: 10px 16px;
            font-weight: 700;
            cursor: pointer;
        }
        .card {
            width: 3.375in;
            height: 2.125in;
            border-radius: 22px;
            background:
                linear-gradient(135deg, rgba(255,255,255,0.9), rgba(255,247,230,0.95)),
                repeating-linear-gradient(60deg, transparent 0 18px, rgba(247,183,51,0.07) 18px 22px),
                repeating-linear-gradient(-60deg, transparent 0 18px, rgba(255,200,61,0.06) 18px 22px);
            border: 2px solid rgba(31,27,22,0.12);
            box-shadow: 0 24px 60px rgba(31,27,22,0.18);
            position: relative;
            overflow: hidden;
            padding: 12px;
        }
        .card::before,
        .card::after {
            content: '';
            position: absolute;
            inset: auto;
            border-radius: 999px;
            background: radial-gradient(circle, rgba(247,183,51,0.65) 0 22%, transparent 24%), radial-gradient(circle, rgba(31,27,22,0.07) 0 18%, transparent 20%);
            opacity: 0.5;
            pointer-events: none;
        }
        .card::before { width: 92px; height: 92px; top: -28px; right: -22px; }
        .card::after { width: 68px; height: 68px; bottom: -22px; left: -18px; }
        .top {
            display: grid;
            grid-template-columns: 0.95in 1fr;
            gap: 10px;
            align-items: center;
        }
        .photo {
            width: 0.95in;
            height: 0.95in;
            border-radius: 16px;
            overflow: hidden;
            border: 3px solid var(--honey-dark);
            background: linear-gradient(180deg, #ffefb6, #f2c56b);
            display: grid;
            place-items: center;
            color: var(--ink);
            font-size: 28px;
            font-weight: 800;
            box-shadow: inset 0 0 0 2px rgba(255,255,255,0.3);
        }
        .photo img { width: 100%; height: 100%; object-fit: cover; }
        .brand {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.68rem;
            font-weight: 800;
            letter-spacing: 0.22em;
            text-transform: uppercase;
            color: var(--honey-dark);
        }
        .bee {
            width: 22px;
            height: 22px;
            border-radius: 50%;
            background: linear-gradient(90deg, #1f1b16 0 18%, #ffc83d 18% 34%, #1f1b16 34% 50%, #ffc83d 50% 66%, #1f1b16 66% 82%, #ffc83d 82% 100%);
            box-shadow: inset 0 0 0 2px rgba(255,255,255,0.4);
        }
        .name {
            margin: 6px 0 2px;
            font-size: 0.9rem;
            font-weight: 800;
            line-height: 1.05;
            color: var(--ink);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .rfid-label {
            font-size: 0.6rem;
            font-weight: 800;
            letter-spacing: 0.14em;
            color: rgba(31,27,22,0.7);
            text-transform: uppercase;
            margin-top: 4px;
        }
        .barcode-wrap {
            margin-top: 8px;
            background: white;
            border-radius: 14px;
            padding: 6px 8px 4px;
            border: 1px solid rgba(31,27,22,0.08);
        }
        #barcode {
            width: 100%;
            height: 54px;
        }
        .rfid-text {
            margin-top: 2px;
            font-size: 0.62rem;
            letter-spacing: 0.18em;
            text-align: center;
            color: rgba(31,27,22,0.85);
            font-weight: 700;
        }
        .footer-note {
            position: absolute;
            right: 12px;
            bottom: 10px;
            font-size: 0.55rem;
            letter-spacing: 0.14em;
            text-transform: uppercase;
            color: rgba(31,27,22,0.6);
        }
        @page { size: 3.375in 2.125in; margin: 0; }
        @media print {
            body { padding: 0; background: white; }
            .toolbar { display: none; }
            .card { box-shadow: none; border-radius: 0; width: 3.375in; height: 2.125in; }
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button onclick="window.print()">Print</button>
        <button onclick="window.close()">Close</button>
    </div>
    <div class="card">
        <div class="brand"><span class="bee"></span><span>Hive Access</span></div>
        <div class="top">
            <div class="photo">${photoUrl ? `<img src="${photoUrl}" alt="${safeName}">` : initials}</div>
            <div>
                <div class="name">${safeName}</div>
                <div class="rfid-label">RFID</div>
                <div class="rfid-text">${safeRfid}</div>
            </div>
        </div>
        <div class="barcode-wrap">
            <svg id="barcode"></svg>
        </div>
        <div class="footer-note">Bee themed access card</div>
    </div>
    <script>
        const rfid = ${JSON.stringify(user.rfid_code || '')};
        if (window.JsBarcode && rfid) {
            JsBarcode('#barcode', rfid, {
                format: 'CODE128',
                displayValue: false,
                margin: 0,
                height: 46,
                width: 1.6
            });
        }
    </script>
</body>
</html>
        `);
    });
});

// --- 5. DATA APIs ---
app.get('/api/users/all', (req, res) => {
    db.all('SELECT * FROM users ORDER BY name ASC', (err, r) => res.json(r || []));
});

app.get('/api/admin/users', (req, res) => {
    const nowInfo = getNowInfo();
    db.all(getDayStatsSql, [nowInfo.ms, nowInfo.date, nowInfo.ms], (err, r) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(r || []);
    });
});

// --- 6. USER ACTIONS (RFID & ID SUPPORT) ---
app.post('/api/get-user-status', (req, res) => {
    db.get('SELECT * FROM users WHERE rfid_code = ?', [req.body.rfid_code], (err, u) => u ? res.json({user: u}) : res.status(404).send());
});

app.post('/api/check-in', (req, res) => {
    const q = req.body.rfid_code ? 'SELECT id FROM users WHERE rfid_code = ?' : 'SELECT id FROM users WHERE id = ?';
    const p = req.body.rfid_code || req.body.user_id;
    db.get(q, [p], (err, u) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!u) return res.status(404).send();

        const nowInfo = getNowInfo();
        db.run('UPDATE users SET status = ? WHERE id = ?', ['checked_in', u.id], (updateErr) => {
            if (updateErr) return res.status(500).json({ error: updateErr.message });

            db.run(
                'INSERT INTO attendance_sessions (user_id, work_date, checked_in_at, checked_in_ms) VALUES (?, ?, ?, ?)',
                [u.id, nowInfo.date, nowInfo.timestamp, nowInfo.ms],
                (sessionErr) => {
                    if (sessionErr) return res.status(500).json({ error: sessionErr.message });

                    db.run(
                        'INSERT INTO attendance_log (user_id, action, timestamp) VALUES (?, ?, ?)',
                        [u.id, 'check_in', nowInfo.timestamp],
                        (logErr) => {
                            if (logErr) return res.status(500).json({ error: logErr.message });
                            res.json({ success: true, status: 'checked_in', message: 'User checked in successfully.' });
                        }
                    );
                }
            );
        });
    });
});

app.post('/api/check-out', (req, res) => {
    const q = req.body.rfid_code ? 'SELECT id FROM users WHERE rfid_code = ?' : 'SELECT id FROM users WHERE id = ?';
    const p = req.body.rfid_code || req.body.user_id;
    db.get(q, [p], (err, u) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!u) return res.status(404).send();

        finalizeCheckOut(u.id, { action: 'check_out', status: 'checked_out' }, res, (user, nowInfo) => {
            if (!user.is_keyholder) return;

            db.get(
                'SELECT COUNT(*) AS count FROM users WHERE is_keyholder = 1 AND status != ? AND id != ?',
                ['checked_out', user.id],
                (countErr, row) => {
                    if (countErr) return res.status(500).json({ error: countErr.message });
                    if ((row && row.count) > 0) {
                        return res.json({ success: true, status: 'checked_out', message: 'User checked out successfully.' });
                    }

                    db.all(
                        'SELECT id FROM users WHERE id != ? AND status != ? ORDER BY name ASC',
                        [user.id, 'checked_out'],
                        (activeErr, activeUsers) => {
                            if (activeErr) return res.status(500).json({ error: activeErr.message });
                            if (!activeUsers || activeUsers.length === 0) {
                                return res.json({ success: true, status: 'checked_out', keyholder: true, massSignedOut: 0, message: 'Keyholder checked out successfully.' });
                            }

                            let remaining = activeUsers.length;

                            activeUsers.forEach(activeUser => {
                                finalizeCheckOut(
                                    activeUser.id,
                                    {
                                        action: 'keyholder_sign_out',
                                        status: 'checked_out',
                                        invalidateDay: true,
                                        invalidateReason: `keyholder:${user.id}`
                                    },
                                    res,
                                    () => {
                                        remaining -= 1;
                                        if (remaining === 0) {
                                            res.json({
                                                success: true,
                                                status: 'checked_out',
                                                keyholder: true,
                                                massSignedOut: activeUsers.length,
                                                message: `Keyholder checked out and signed out ${activeUsers.length} other user${activeUsers.length === 1 ? '' : 's'}.`
                                            });
                                        }
                                    }
                                );
                            });
                        }
                    );
                }
            );
        });
    });
});

app.post('/api/break/start', (req, res) => {
    const q = req.body.rfid_code ? 'SELECT id FROM users WHERE rfid_code = ?' : 'SELECT id FROM users WHERE id = ?';
    const p = req.body.rfid_code || req.body.user_id;
    db.get(q, [p], (err, u) => u ? logAction(u.id, 'on_break', 'break_start', res) : res.status(404).send());
});

app.post('/api/break/end', (req, res) => {
    logAction(req.body.user_id, 'checked_in', 'break_end', res);
});

app.get('/api/status/onbreak', (req, res) => {
    db.all(
        'SELECT id, name FROM users WHERE status = ? ORDER BY name ASC',
        ['on_break'],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ users_on_break: rows || [] });
        }
    );
});

app.get('/api/status/checkedin', (req, res) => {
    db.all(
        'SELECT name FROM users WHERE status = ? ORDER BY name ASC',
        ['checked_in'],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ users_checked_in: (rows || []).map(row => row.name) });
        }
    );
});

// --- 7. FACE & PHOTO MANAGEMENT ---
app.post('/api/admin/users/enroll-face', (req, res) => {
    const { userId, faceDescriptor } = req.body;
    
    // First, get the existing descriptors
    db.get('SELECT face_descriptor FROM users WHERE id = ?', [userId], (err, row) => {
        let descriptors = [];
        if (row && row.face_descriptor) {
            descriptors = JSON.parse(row.face_descriptor);
            // If it's an old single-string format, convert to array
            if (!Array.isArray(descriptors)) descriptors = [descriptors];
        }

        // Add the new one (limit to 5 samples to keep it fast)
        descriptors.push(JSON.parse(faceDescriptor));
        if (descriptors.length > 5) descriptors.shift(); 

        db.run('UPDATE users SET face_descriptor = ? WHERE id = ?', 
            [JSON.stringify(descriptors), userId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, count: descriptors.length });
        });
    });
});

app.post('/api/admin/users/upload-photo', upload.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const photoUrl = `/uploads/${req.file.filename}`;
    db.run('UPDATE users SET profile_picture_url = ? WHERE id = ?', [photoUrl, req.body.userId], (err) => {
        if (err) return res.status(500).send(err.message);
        res.json({ success: true, url: photoUrl });
    });
});

// --- 8. CERTIFICATIONS ---
app.get('/api/admin/certifications', (req, res) => {
    db.all('SELECT * FROM certifications ORDER BY name ASC', (err, r) => res.json(r || []));
});

app.post('/api/admin/certifications/create', (req, res) => {
    db.run('INSERT INTO certifications (name) VALUES (?)', [req.body.name], function() {
        res.json({ id: this.lastID });
    });
});

app.get('/api/admin/users/:userId/certifications', (req, res) => {
    db.all('SELECT c.name FROM certifications c JOIN user_certifications uc ON c.id = uc.certification_id WHERE uc.user_id = ?', 
    [req.params.userId], (err, r) => res.json(r || []));
});

app.post('/api/admin/certifications/assign', (req, res) => {
    db.run('INSERT INTO user_certifications (user_id, certification_id) VALUES (?, ?)', 
    [req.body.user_id, req.body.certification_id], () => res.json({ success: true }));
});

// --- 9. ADMIN USER MANAGEMENT ---
app.post('/api/admin/users/create', (req, res) => {
    const { name, rfid_code, is_keyholder } = req.body;
    db.run('INSERT INTO users (name, rfid_code, status, is_keyholder) VALUES (?, ?, "checked_out", ?)', 
    [name, rfid_code, is_keyholder ? 1 : 0], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID });
    });
});

app.post('/api/admin/users/:id/keyholder', (req, res) => {
    db.run('UPDATE users SET is_keyholder = ? WHERE id = ?', [req.body.is_keyholder ? 1 : 0, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post('/api/admin/force-checkout', (req, res) => {
    db.get('SELECT id FROM users WHERE id = ?', [req.body.user_id], (err, u) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!u) return res.status(404).send();
        finalizeCheckOut(u.id, { action: 'force_check_out', status: 'checked_out' }, res);
    });
});

app.delete('/api/admin/users/delete/:id', (req, res) => {
    db.run('DELETE FROM users WHERE id = ?', [req.params.id], () => res.send("Deleted"));
});

// --- 10. PDF REPORT GENERATOR ---
app.get('/api/admin/attendance/pdf', (req, res) => {
    const targetDate = req.query.date || getMSTDate();
    const sql = `SELECT u.name, al.action, al.timestamp FROM attendance_log al 
                 JOIN users u ON al.user_id = u.id 
                 WHERE date(al.timestamp) = ? 
                 ORDER BY u.name, al.timestamp ASC`;

    db.all(sql, [targetDate], (err, rows) => {
        if (err || !rows || rows.length === 0) return res.status(404).send("No data found for this date.");
        
        const doc = new PDFDocument();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=attendance-${targetDate}.pdf`);
        doc.pipe(res);
        
        doc.fontSize(20).text(`Attendance Report: ${targetDate}`, { align: 'center' }).moveDown();
        rows.forEach(r => {
            const time = r.timestamp.split(' ')[1];
            doc.fontSize(12).text(`[${time}] ${r.name.padEnd(20)} | Action: ${r.action.replace('_', ' ')}`);
        });

        doc.moveDown().fontSize(16).text('Hours Summary').moveDown(0.5);
        const isToday = targetDate === getMSTDate();
        const hoursSql = isToday
            ? `SELECT u.name,
                      SUM(CASE
                              WHEN s.invalidated = 1 THEN 0
                              WHEN s.checked_out_ms IS NULL THEN ROUND((? - s.checked_in_ms) / 60000.0)
                              ELSE s.duration_minutes
                          END) AS minutes
               FROM attendance_sessions s
               JOIN users u ON u.id = s.user_id
               WHERE s.work_date = ?
               GROUP BY s.user_id
               ORDER BY u.name ASC`
            : `SELECT u.name, SUM(s.duration_minutes) AS minutes
               FROM attendance_sessions s
               JOIN users u ON u.id = s.user_id
               WHERE s.work_date = ? AND s.invalidated = 0
               GROUP BY s.user_id
               ORDER BY u.name ASC`;

        const hoursParams = isToday ? [getNowInfo().ms, targetDate] : [targetDate];

        db.all(hoursSql, hoursParams, (hoursErr, hoursRows) => {
            if (!hoursErr && hoursRows && hoursRows.length > 0) {
                hoursRows.forEach(row => {
                    doc.fontSize(12).text(`${row.name.padEnd(20)} | ${formatMinutes(row.minutes)}`);
                });
            } else {
                doc.fontSize(12).text('No valid hours recorded for this date.');
            }
            doc.end();
        });
    });
});

// --- START SERVER ---
app.listen(3000, () => console.log('✅ Full Kiosk Server Running on http://localhost:3000'));