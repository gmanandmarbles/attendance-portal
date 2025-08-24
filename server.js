const express = require('express');
const app = express();
const db = require('./database');
const bodyParser = require('body-parser');
const path = require('path');
const PDFDocument = require('pdfkit');

const HTTP_PORT = 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, '')));

app.listen(HTTP_PORT, () => {
    console.log(`Server running on port ${HTTP_PORT}`);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Endpoint to get a user's status without changing it
app.post('/api/get-user-status', (req, res) => {
    const { rfid_code } = req.body;
    if (!rfid_code) {
        return res.status(400).json({ error: 'RFID code is required.' });
    }

    db.get('SELECT id, name, status FROM users WHERE rfid_code = ?', [rfid_code], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        res.json({ user });
    });
});

// Endpoint for check-in
app.post('/api/check-in', (req, res) => {
    const { rfid_code } = req.body;
    if (!rfid_code) {
        return res.status(400).json({ error: 'RFID code is required.' });
    }

    db.get('SELECT id, name, status FROM users WHERE rfid_code = ?', [rfid_code], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        if (user.status !== 'checked_out') {
            return res.status(400).json({ error: `${user.name} is already checked in or on break. Cannot check in.` });
        }
        
        db.run('UPDATE users SET status = ? WHERE id = ?', ['checked_in', user.id], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            db.run('INSERT INTO attendance_log (user_id, action) VALUES (?, ?)', [user.id, 'check_in'], (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                res.json({ message: `Welcome, ${user.name}! You are now checked in.`, user: { ...user, status: 'checked_in' } });
            });
        });
    });
});

// Endpoint for check-out
app.post('/api/check-out', (req, res) => {
    const { rfid_code } = req.body;
    if (!rfid_code) {
        return res.status(400).json({ error: 'RFID code is required.' });
    }

    db.get('SELECT id, name, status FROM users WHERE rfid_code = ?', [rfid_code], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        if (user.status !== 'checked_in') {
             return res.status(400).json({ error: `${user.name} is not checked in. Cannot check out.` });
        }

        db.run('UPDATE users SET status = ? WHERE id = ?', ['checked_out', user.id], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            db.run('INSERT INTO attendance_log (user_id, action) VALUES (?, ?)', [user.id, 'check_out'], (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                res.json({ message: `Goodbye, ${user.name}! You are now checked out.`, user: { ...user, status: 'checked_out' } });
            });
        });
    });
});

// Endpoint to start a break
app.post('/api/break/start', (req, res) => {
    const { rfid_code } = req.body;
    if (!rfid_code) {
        return res.status(400).json({ error: 'RFID code is required.' });
    }

    db.get('SELECT id, name, status FROM users WHERE rfid_code = ?', [rfid_code], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        if (user.status !== 'checked_in') {
            return res.status(400).json({ error: 'User must be checked in to go on a break.' });
        }

        db.run('UPDATE users SET status = ? WHERE id = ?', ['on_break', user.id], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            db.run('INSERT INTO attendance_log (user_id, action) VALUES (?, ?)', [user.id, 'break_start'], (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                res.json({ message: `${user.name}, you are now on break.`, user: { ...user, status: 'on_break' } });
            });
        });
    });
});

// Endpoint to end a break
app.post('/api/break/end', (req, res) => {
    const { user_id } = req.body;
    if (!user_id) {
        return res.status(400).json({ error: 'User ID is required.' });
    }

    db.get('SELECT id, name, status FROM users WHERE id = ?', [user_id], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        if (user.status !== 'on_break') {
            return res.status(400).json({ error: 'User must be on break to return from break.' });
        }

        db.run('UPDATE users SET status = ? WHERE id = ?', ['checked_in', user.id], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            db.run('INSERT INTO attendance_log (user_id, action) VALUES (?, ?)', [user.id, 'break_end'], (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                res.json({ message: `${user.name}, break is over. You are now checked in.`, user: { ...user, status: 'checked_in' } });
            });
        });
    });
});

// Endpoint to get a list of users on break
app.get('/api/status/onbreak', (req, res) => {
    const sql = `
        SELECT id, name
        FROM users
        WHERE status = 'on_break'
    `;
    db.all(sql, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ users_on_break: rows });
    });
});

// Endpoint to get a list of checked-in users
app.get('/api/status/checkedin', (req, res) => {
    db.all('SELECT name FROM users WHERE status = ?', ['checked_in'], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ users_checked_in: rows.map(row => row.name) });
    });
});

// Admin endpoint to get all users
app.get('/api/admin/users', (req, res) => {
    db.all('SELECT id, name, rfid_code, status FROM users', [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Admin endpoint to create a user
app.post('/api/admin/users/create', (req, res) => {
    const { name, rfid_code } = req.body;
    if (!name || !rfid_code) {
        return res.status(400).json({ error: 'Name and RFID code are required.' });
    }
    const insert = 'INSERT INTO users (name, rfid_code) VALUES (?, ?)';
    db.run(insert, [name, rfid_code], function(err) {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        res.json({ message: 'User created successfully.', userId: this.lastID });
    });
});

// Admin endpoint to delete a user
app.delete('/api/admin/users/delete/:id', (req, res) => {
    const { id } = req.params;
    db.run('DELETE FROM users WHERE id = ?', id, function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: `User with ID ${id} deleted successfully.` });
    });
});

// Admin endpoint to force a user to check out
app.post('/api/admin/force-checkout', (req, res) => {
    const { user_id } = req.body;
    if (!user_id) {
        return res.status(400).json({ error: 'User ID is required.' });
    }

    db.get('SELECT id, name, status FROM users WHERE id = ?', [user_id], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        if (user.status === 'checked_out') {
            return res.status(400).json({ error: `${user.name} is already checked out.` });
        }
        
        const action = 'force_checkout';
        
        db.run('UPDATE users SET status = ? WHERE id = ?', ['checked_out', user.id], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            db.run('INSERT INTO attendance_log (user_id, action) VALUES (?, ?)', [user.id, action], (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                res.json({ message: `${user.name} has been forced to check out.`, user });
            });
        });
    });
});

// Admin endpoint to download a CSV log
app.get('/api/admin/attendance/download', (req, res) => {
    const { date } = req.query;
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const targetDate = date || today;

    const sql = `
        SELECT u.name, al.action, al.timestamp
        FROM attendance_log al
        JOIN users u ON al.user_id = u.id
        WHERE date(al.timestamp) = ?
        ORDER BY al.timestamp ASC
    `;
    
    db.all(sql, [targetDate], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (rows.length === 0) {
            return res.status(404).json({ message: 'No attendance data found for this date.' });
        }

        const csvRows = ['Name,Action,Timestamp'];
        rows.forEach(row => {
            csvRows.push(`${row.name},${row.action},${row.timestamp}`);
        });

        const csvContent = csvRows.join('\n');
        const filename = `attendance_log_${targetDate}.csv`;

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvContent);
    });
});

// Admin endpoint to generate a human-readable PDF report
app.get('/api/admin/attendance/pdf', (req, res) => {
    const { date } = req.query;
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const targetDate = date || today;

    const sql = `
        SELECT u.name, u.status, al.action, al.timestamp
        FROM attendance_log al
        JOIN users u ON al.user_id = u.id
        WHERE date(al.timestamp) = ?
        ORDER BY u.name, al.timestamp ASC
    `;

    db.all(sql, [targetDate], (err, rows) => {
        if (err) { return res.status(500).json({ error: err.message }); }
        if (rows.length === 0) { return res.status(404).json({ message: 'No attendance data found for this date.' }); }

        const attendanceData = {};
        rows.forEach(row => {
            if (!attendanceData[row.name]) { attendanceData[row.name] = { logs: [] }; }
            attendanceData[row.name].logs.push(row);
        });

        const doc = new PDFDocument();
        const filename = `attendance_report_${targetDate}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        doc.pipe(res);
        doc.font('Helvetica-Bold').fontSize(16).text(`Attendance Report for ${targetDate}`, { align: 'center' });
        doc.moveDown();

        // New section for list of attendees
        doc.font('Helvetica-Bold').fontSize(14).text('Attendees', { underline: true });
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(12);
        
        const attendees = Object.keys(attendanceData).sort();
        attendees.forEach(name => {
            doc.text(`- ${name}`);
        });
        doc.moveDown();
        
        // Detailed log section
        doc.font('Helvetica-Bold').fontSize(14).text('Detailed Log', { underline: true });
        doc.moveDown(0.5);
        
        for (const name in attendanceData) {
            doc.font('Helvetica-Bold').fontSize(12).text(name);
            doc.font('Helvetica').fontSize(10);

            const logs = attendanceData[name].logs;
            let checkInTime = null;
            let breakStart = null;
            logs.forEach(log => {
                const timestamp = new Date(log.timestamp);
                const time = timestamp.toLocaleTimeString();
                if (log.action === 'check_in') { checkInTime = time; doc.text(`  - Checked In: ${time}`); }
                else if (log.action === 'check_out' || log.action === 'force_checkout') { const checkoutTime = time; if (checkInTime) { doc.text(`  - Checked Out: ${checkoutTime}`); checkInTime = null; } }
                else if (log.action === 'break_start') { breakStart = time; doc.text(`  - Break Started: ${breakStart}`); }
                else if (log.action === 'break_end') { const breakEnd = time; if (breakStart) { doc.text(`  - Break Ended: ${breakEnd}`); breakStart = null; } }
            });
            doc.moveDown();
        }
        doc.end();
    });
});


// === NEW CERTIFICATION ENDPOINTS ===

// Admin endpoint to get all certifications
app.get('/api/admin/certifications', (req, res) => {
    db.all('SELECT id, name FROM certifications', [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Admin endpoint to create a certification
app.post('/api/admin/certifications/create', (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Certification name is required.' });
    }
    const insert = 'INSERT INTO certifications (name) VALUES (?)';
    db.run(insert, [name], function(err) {
        if (err) {
            // Check for unique constraint violation
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: `A certification with the name "${name}" already exists.` });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: 'Certification created successfully.', certificationId: this.lastID });
    });
});

// Admin endpoint to assign a certification to a user
app.post('/api/admin/certifications/assign', (req, res) => {
    const { user_id, certification_id } = req.body;
    if (!user_id || !certification_id) {
        return res.status(400).json({ error: 'User ID and Certification ID are required.' });
    }

    const insert = 'INSERT INTO user_certifications (user_id, certification_id) VALUES (?, ?)';
    db.run(insert, [user_id, certification_id], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: 'This certification is already assigned to this user.' });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: 'Certification assigned successfully.' });
    });
});

// Admin endpoint to revoke a certification from a user
app.delete('/api/admin/certifications/revoke/:userId/:certId', (req, res) => {
    const { userId, certId } = req.params;
    db.run('DELETE FROM user_certifications WHERE user_id = ? AND certification_id = ?', [userId, certId], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'No such certification assignment found.' });
        }
        res.json({ message: 'Certification revoked successfully.' });
    });
});

// Admin endpoint to get a user's certifications
app.get('/api/admin/users/:userId/certifications', (req, res) => {
    const { userId } = req.params;
    const sql = `
        SELECT c.id, c.name 
        FROM certifications c
        JOIN user_certifications uc ON c.id = uc.certification_id
        WHERE uc.user_id = ?
    `;
    db.all(sql, [userId], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});


app.use((req, res, next) => {
    res.status(404).json({ error: 'Not found' });
});