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

const getMST = () => new Date().toLocaleString("en-CA", {timeZone: "America/Denver", hour12: false}).replace(',', '');

// Helper for Attendance Logs
const logAction = (userId, status, action, res) => {
    db.run('UPDATE users SET status = ? WHERE id = ?', [status, userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run('INSERT INTO attendance_log (user_id, action, timestamp) VALUES (?, ?, ?)', [userId, action, getMST()], () => {
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
    db.all('SELECT * FROM users ORDER BY name ASC', (err, r) => res.json(r || []));
});

// --- 6. USER ACTIONS (RFID & ID SUPPORT) ---
app.post('/api/get-user-status', (req, res) => {
    db.get('SELECT * FROM users WHERE rfid_code = ?', [req.body.rfid_code], (err, u) => u ? res.json({user: u}) : res.status(404).send());
});

app.post('/api/check-in', (req, res) => {
    const q = req.body.rfid_code ? 'SELECT id FROM users WHERE rfid_code = ?' : 'SELECT id FROM users WHERE id = ?';
    const p = req.body.rfid_code || req.body.user_id;
    db.get(q, [p], (err, u) => u ? logAction(u.id, 'checked_in', 'check_in', res) : res.status(404).send());
});

app.post('/api/check-out', (req, res) => {
    const q = req.body.rfid_code ? 'SELECT id FROM users WHERE rfid_code = ?' : 'SELECT id FROM users WHERE id = ?';
    const p = req.body.rfid_code || req.body.user_id;
    db.get(q, [p], (err, u) => u ? logAction(u.id, 'checked_out', 'check_out', res) : res.status(404).send());
});

app.post('/api/break/start', (req, res) => {
    const q = req.body.rfid_code ? 'SELECT id FROM users WHERE rfid_code = ?' : 'SELECT id FROM users WHERE id = ?';
    const p = req.body.rfid_code || req.body.user_id;
    db.get(q, [p], (err, u) => u ? logAction(u.id, 'on_break', 'break_start', res) : res.status(404).send());
});

app.post('/api/break/end', (req, res) => {
    logAction(req.body.user_id, 'checked_in', 'break_end', res);
});

// --- 7. FACE & PHOTO MANAGEMENT ---
app.post('/api/admin/users/enroll-face', (req, res) => {
    const { userId, faceDescriptor } = req.body;
    db.run('UPDATE users SET face_descriptor = ? WHERE id = ?', [faceDescriptor, userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
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
    const { name, rfid_code } = req.body;
    db.run('INSERT INTO users (name, rfid_code, status) VALUES (?, ?, "checked_out")', 
    [name, rfid_code], function() {
        res.json({ id: this.lastID });
    });
});

app.delete('/api/admin/users/delete/:id', (req, res) => {
    db.run('DELETE FROM users WHERE id = ?', [req.params.id], () => res.send("Deleted"));
});

// --- 10. PDF REPORT GENERATOR ---
app.get('/api/admin/attendance/pdf', (req, res) => {
    const targetDate = req.query.date || getMST().split(' ')[0];
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
        doc.end();
    });
});

// --- START SERVER ---
app.listen(3000, () => console.log('✅ Full Kiosk Server Running on http://localhost:3000'));