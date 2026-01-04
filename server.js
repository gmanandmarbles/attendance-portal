const express = require('express');
const app = express();
const db = require('./database');
const path = require('path');
const PDFDocument = require('pdfkit');
const bodyParser = require('body-parser');

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '')));

const getMST = () => new Date().toLocaleString("en-CA", {timeZone: "America/Denver", hour12: false}).replace(',', '');

// Helper to update status and log to DB
const logAction = (userId, status, action, res) => {
    db.run('UPDATE users SET status = ? WHERE id = ?', [status, userId], () => {
        db.run('INSERT INTO attendance_log (user_id, action, timestamp) VALUES (?, ?, ?)', [userId, action, getMST()], () => {
            res.json({ success: true, status });
        });
    });
};

// Page Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/tablet', (req, res) => res.sendFile(path.join(__dirname, 'ipad.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// --- Status & Grid APIs ---
app.get('/api/users/all', (req, res) => db.all('SELECT * FROM users', (err, r) => res.json(r)));
app.get('/api/status/onbreak', (req, res) => db.all("SELECT id, name FROM users WHERE status = 'on_break'", (err, r) => res.json({users_on_break: r})));
app.get('/api/status/checkedin', (req, res) => db.all("SELECT name FROM users WHERE status = 'checked_in'", (err, r) => res.json({users_checked_in: r.map(u => u.name)})));

// --- User Actions ---
app.post('/api/get-user-status', (req, res) => {
    db.get('SELECT * FROM users WHERE rfid_code = ?', [req.body.rfid_code], (err, u) => u ? res.json({user: u}) : res.status(404).send());
});

app.post('/api/check-in', (req, res) => {
    db.get('SELECT id FROM users WHERE rfid_code = ?', [req.body.rfid_code], (err, u) => u ? logAction(u.id, 'checked_in', 'check_in', res) : res.status(404).send());
});

app.post('/api/check-out', (req, res) => {
    db.get('SELECT id FROM users WHERE rfid_code = ?', [req.body.rfid_code], (err, u) => u ? logAction(u.id, 'checked_out', 'check_out', res) : res.status(404).send());
});

app.post('/api/break/start', (req, res) => {
    db.get('SELECT id FROM users WHERE rfid_code = ?', [req.body.rfid_code], (err, u) => u ? logAction(u.id, 'on_break', 'break_start', res) : res.status(404).send());
});

app.post('/api/break/end', (req, res) => logAction(req.body.user_id, 'checked_in', 'break_end', res));

// --- Certifications (RESTORED) ---
// Get master list of all possible certs
app.get('/api/admin/certifications', (req, res) => db.all('SELECT * FROM certifications', (err, r) => res.json(r)));

// Create a new cert type
app.post('/api/admin/certifications/create', (req, res) => {
    db.run('INSERT INTO certifications (name) VALUES (?)', [req.body.name], function() { res.json({id: this.lastID}); });
});

// Get certs assigned to a specific user
app.get('/api/admin/users/:userId/certifications', (req, res) => {
    db.all('SELECT c.name FROM certifications c JOIN user_certifications uc ON c.id = uc.certification_id WHERE uc.user_id = ?', [req.params.userId], (err, r) => res.json(r));
});

// Assign cert to user
app.post('/api/admin/certifications/assign', (req, res) => {
    db.run('INSERT INTO user_certifications (user_id, certification_id) VALUES (?, ?)', [req.body.user_id, req.body.certification_id], () => res.json({success: true}));
});

// --- Admin Management ---
app.get('/api/admin/users', (req, res) => db.all('SELECT * FROM users', (err, r) => res.json(r)));
app.post('/api/admin/users/create', (req, res) => {
    db.run('INSERT INTO users (name, rfid_code, status) VALUES (?, ?, "checked_out")', [req.body.name, req.body.rfid_code], function() { res.json({id: this.lastID}); });
});
app.delete('/api/admin/users/delete/:id', (req, res) => db.run('DELETE FROM users WHERE id = ?', [req.params.id], () => res.send()));

// --- PDF Report ---
app.get('/api/admin/attendance/pdf', (req, res) => {
    const targetDate = req.query.date || getMST().split(' ')[0];
    const sql = `SELECT u.name, al.action, al.timestamp FROM attendance_log al JOIN users u ON al.user_id = u.id WHERE date(al.timestamp) = ? ORDER BY u.name, al.timestamp ASC`;
    db.all(sql, [targetDate], (err, rows) => {
        if (!rows || rows.length === 0) return res.status(404).send("No data");
        const doc = new PDFDocument();
        res.setHeader('Content-Type', 'application/pdf');
        doc.pipe(res);
        doc.fontSize(18).text(`Attendance Report: ${targetDate} (MST)`, {align: 'center'}).moveDown();
        rows.forEach(r => doc.fontSize(11).text(`[${r.timestamp.split(' ')[1]}] ${r.name}: ${r.action.replace('_', ' ')}`));
        doc.end();
    });
});

app.listen(3000, () => console.log('Kiosk running on port 3000'));