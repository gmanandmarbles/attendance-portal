const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DBSOURCE = path.join(__dirname, 'attendance.db');
const dbExists = fs.existsSync(DBSOURCE);

const db = new sqlite3.Database(DBSOURCE, (err) => {
    if (err) {
        console.error(err.message);
        throw err;
    } else {
        console.log('Connected to the SQLite database.');

        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rfid_code TEXT UNIQUE,
            name TEXT,
            status TEXT DEFAULT 'checked_out'
        )`, (err) => {
            if (err) {
                console.error('Error creating users table:', err.message);
            }
        });

        db.run(`CREATE TABLE IF NOT EXISTS attendance_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )`, (err) => {
            if (err) {
                console.error('Error creating attendance_log table:', err.message);
            }
        });

        // Only insert sample data if the database file did not exist before
        if (!dbExists) {
            console.log('Database not found, inserting sample data.');
            const insert = 'INSERT INTO users (rfid_code, name) VALUES (?, ?)';
            db.run(insert, ['a', 'Alice']);
            db.run(insert, ['b', 'Bob']);
            db.run(insert, ['c', 'Charlie']);
        }
    }
});

module.exports = db;