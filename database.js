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

        // Add the new certifications table
        db.run(`CREATE TABLE IF NOT EXISTS certifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        )`, (err) => {
            if (err) {
                console.error('Error creating certifications table:', err.message);
            }
        });

        // Add the new user_certifications table to link users and certifications
        db.run(`CREATE TABLE IF NOT EXISTS user_certifications (
            user_id INTEGER,
            certification_id INTEGER,
            PRIMARY KEY (user_id, certification_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (certification_id) REFERENCES certifications(id) ON DELETE CASCADE
        )`, (err) => {
            if (err) {
                console.error('Error creating user_certifications table:', err.message);
            }
        });

        // Only insert sample data if the database file did not exist before
        if (!dbExists) {
            console.log('Database not found, inserting sample data.');
            const insertUser = 'INSERT INTO users (rfid_code, name) VALUES (?, ?)';
            db.run(insertUser, ['a', 'Alice']);
            db.run(insertUser, ['b', 'Bob']);
            db.run(insertUser, ['c', 'Charlie']);

            const insertCert = 'INSERT INTO certifications (name) VALUES (?)';
            db.run(insertCert, ['First Aid']);
            db.run(insertCert, ['Forklift Operator']);
            db.run(insertCert, ['CPR Certified']);
        }
    }
});

module.exports = db;