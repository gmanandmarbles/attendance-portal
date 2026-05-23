const express = require('express');
const app = express();
const db = require('./database');
const path = require('path');
const fs = require('fs');
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

// --- 3. MIDDLEWARE ---
app.use(bodyParser.json());
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
            res.json({ success: true, status });
        });
    });
};

// --- 4. PAGE ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/tablet', (req, res) => res.sendFile(path.join(__dirname, 'ipad.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/upload', (req, res) => res.sendFile(path.join(__dirname, 'upload.html')));
app.get('/face-setup', (req, res) => res.sendFile(path.join(__dirname, 'face-setup.html')));

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
                            res.json({ success: true, status: 'checked_in' });
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
                        return res.json({ success: true, status: 'checked_out' });
                    }

                    db.all(
                        'SELECT id FROM users WHERE id != ? AND status != ? ORDER BY name ASC',
                        [user.id, 'checked_out'],
                        (activeErr, activeUsers) => {
                            if (activeErr) return res.status(500).json({ error: activeErr.message });
                            if (!activeUsers || activeUsers.length === 0) {
                                return res.json({ success: true, status: 'checked_out', keyholder: true, massSignedOut: 0 });
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
                                                massSignedOut: activeUsers.length
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