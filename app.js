const path = require('path');
const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();

// =========================
// MULTER
// =========================

const storage = multer.diskStorage({

    destination: (req, file, cb) => {

        cb(null, 'public/images');

    },

    filename: (req, file, cb) => {

        cb(null, file.originalname);

    }

});

const upload = multer({ storage: storage });

// =========================
// DATABASE
// =========================

const pool = mysql.createPool({

    host: 'bc-vkg.h.filess.io',

    port: 61032,

    user: 'fyp_stayhumble_angryfixam',

    password: 'f6ce23a78a4b389ecc734b23987d6d25e47b98fa',

    database: 'fyp_stayhumble_angryfixam',

    waitForConnections: true,

    connectionLimit: 10,

    queueLimit: 0,

    connectTimeout: 10000

}).promise();

// =========================
// SETTINGS
// =========================

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));

app.use(express.urlencoded({ extended: false }));

function laplaceNoise(scale) {
    const u = Math.random() - 0.5;
    return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

function dpServerId(serverId, epsilon = 0.5, sensitivity = 1) {
    const numericId = Number(serverId);
    if (Number.isNaN(numericId)) {
        console.warn(`dpServerId: serverId is not numeric, storing raw value instead: ${serverId}`);
        return serverId;
    }
    const noise = laplaceNoise(sensitivity / epsilon);
    return Math.round(numericId + noise);
}

const crypto = require('crypto');

function generateAddressToken(length = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        token += chars[bytes[i] % chars.length];
    }
    return token;
}

// Saves the real address in the vault table and returns the token.
async function saveAddressToVault(realAddress) {
    let token = generateAddressToken(16);

    while (true) {
        try {
            await pool.execute(
                `INSERT INTO address_vault (token, real_address) VALUES (?, ?)`,
                [token, realAddress]
            );
            return token;
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                token = generateAddressToken(16);
                continue;
            }
            throw err;
        }
    }
}

// Session middleware
app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 1 week
}));

function requireAdmin(req, res, next) {
    if (req.session && req.session.role === 'admin') {
        return next();
    }
    return res.redirect('/login');
}

// =========================
// HOME
// =========================

function moveFieldToEnd(obj, fieldName) {
    if (obj && typeof obj === 'object' && fieldName in obj) {
        const value = obj[fieldName];
        delete obj[fieldName];
        obj[fieldName] = value;
    }
}

app.get("/", (req, res) => {

    res.render("home");

});

// =========================
// LOGIN PAGE
// =========================

app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        const [rows] = await pool.execute(
            'SELECT adminId, username, password, role FROM admin WHERE username = ? LIMIT 1',
            [username]
        );

        if (rows.length === 0) {
            return res.status(401).send('Invalid username or password');
        }

        const admin = rows[0];
        const match = await bcrypt.compare(password, admin.password);

        if (!match) {
            return res.status(401).send('Invalid username or password');
        }

        if (admin.role !== 'admin') {
            return res.status(403).send('User does not have admin privileges');
        }

        req.session.adminId = admin.adminId;
        req.session.role = admin.role;

        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).send('Login error');
    }
});

// GET /logout
app.get('/logout', (req, res) => {
    if (req.session) {
        req.session.destroy((err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Logout error');
            }
            res.redirect('/');
        });
    } else {
        res.redirect('/');
    }
});

// =========================
// SHOW ALL PLAYERS
// =========================

app.get('/players', async (req, res) => {
    try {
        const [players] = await pool.execute(`
            SELECT playerId, name, age, email, username, serverId, teamName, role, region, swappedRegion AS swappedRegion
            FROM player
            ORDER BY teamName ASC
        `);

        console.log('DEBUG: rendering players view, players count=', players.length);
        try {
            console.log('DEBUG: players sample:', JSON.stringify(players.slice(0,5), null, 2));
        } catch (e) {
            console.log('DEBUG: could not stringify players', e);
        }

        // Detailed per-player serverId diagnostics
        if (players.length > 0) {
            console.log('DEBUG: player object keys:', Object.keys(players[0]));
            players.forEach(p => {
                console.log(`DEBUG: playerId=${p.playerId} serverId=${p.serverId} (type=${typeof p.serverId})`);
            });
        } else {
            console.log('DEBUG: no players to inspect');
        }
        res.render('players', { players });
    } catch (err) {
        console.error('Error loading players:', err);
        res.status(500).send('Error loading players');
    }
});

// =========================
// DEBUG: raw players JSON (temporary)
// =========================

app.get('/debug/players', async (req, res) => {
    try {
        const [players] = await pool.execute(`
            SELECT playerId, name, age, email, username, serverId, teamName, role, region, swappedRegion AS swappedRegion
            FROM player
            ORDER BY teamName ASC
        `);

        console.log('DEBUG /debug/players count=', players.length);
        return res.json(players);
    } catch (err) {
        console.error('Error /debug/players:', err);
        res.status(500).json({ error: 'Error loading players' });
    }
});

// =========================
// ADD PLAYER PAGE
// =========================

app.get("/players/add", requireAdmin, async (req, res) => {
    try {

        const [teams] = await pool.execute(`
            SELECT DISTINCT teamName
            FROM team
            WHERE teamName IS NOT NULL
            AND teamName != ''
            ORDER BY teamName ASC
        `);

        res.render("addplayer", { teams });

    } catch (err) {

        console.error(err);

        res.status(500).send("Error loading add player page");

    }

});

// =========================
// ADD PLAYER
// =========================

app.post("/players/add", requireAdmin, async (req, res) => {

    try {

        // normalize/move region fields if provided under different names
        moveFieldToEnd(req.body, 'region');
        moveFieldToEnd(req.body, 'singaporeRegion');

        const {

            name,
            age,
            ic,
            phoneNumber,
            email,
            username,
            accountId,
            serverId,
            address,
            postalCode,
            singaporeRegion,
            country,
            teamName,
            role,
            password

        } = req.body;

        const regionValue = singaporeRegion || req.body.region || '';
        const noisedServerId = dpServerId(serverId);
        const addressToken = await saveAddressToVault(address);

        let swappedRegionValue = regionValue;

        const [existingPlayers] = await pool.execute(`
            SELECT playerId, region
            FROM player
            WHERE region IS NOT NULL AND region != ''
            ORDER BY RAND()
            LIMIT 1
        `);

        if (existingPlayers.length > 0) {
            const existing = existingPlayers[0];
            if (existing.region && existing.region !== '') {
                swappedRegionValue = existing.region;
                await pool.execute(`
                    UPDATE player
                    SET region = ?
                    WHERE playerId = ?
                `, [regionValue, existing.playerId]);
            }
        }

        await pool.execute(`

            INSERT INTO player (

                name,
                age,
                ic,
                phoneNumber,
                email,
                username,
                accountId,
                serverId,
                address,
                postalCode,
                region,
                swappedRegion,
                country,
                teamName,
                role,
                password

            )

            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

        `, [

            name,
            age,
            ic,
            phoneNumber,
            email,
            username,
            accountId,
            noisedServerId,
            addressToken,
            postalCode,
            regionValue,
            swappedRegionValue,
            country,
            teamName,
            role,
            password

        ]);

        res.redirect("/players");

    } catch (err) {

        console.error(err);

        res.status(500).send("Error adding player");

    }

});

// =========================
// DELETE PLAYER
// =========================

app.post('/players/delete/:playerId', async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const { playerId } = req.params;

        await connection.beginTransaction();

        const [rows] = await connection.execute(
            'SELECT address FROM player WHERE playerId = ?',
            [playerId]
        );

        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).send('Player not found');
        }

        const addressToken = rows[0].address;

        await connection.execute(
            'DELETE FROM player WHERE playerId = ?',
            [playerId]
        );

        await connection.execute(
            'DELETE FROM address_vault WHERE token = ?',
            [addressToken]
        );

        await connection.commit();
        res.redirect('/players');
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).send('Error deleting player');
    } finally {
        connection.release();
    }
});

// =========================
// DELETE TEAM
// =========================

app.post('/teams/delete/:teamId', requireAdmin, async (req, res) => {
    try {
        const { teamId } = req.params;

        await pool.execute(
            `DELETE FROM team WHERE teamId = ?`,
            [teamId]
        );

        res.redirect('/teams');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error deleting team");
    }
});

// =========================
// ADD TEAM PAGE
// =========================

app.get("/teams/add", requireAdmin, async (req, res) => {
    try {
        res.render("addteam");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading add team page");
    }
});

app.post("/teams/add", requireAdmin, async (req, res) => {
    try {
        const { teamName } = req.body;

        await pool.execute(
            `INSERT INTO team (teamName) VALUES (?)`,
            [teamName]
        );

        res.redirect("/teams");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error adding team");
    }
});

// =========================
// SHOW ALL TEAMS
// =========================

app.get('/teams', requireAdmin, async (req, res) => {
    try {
        const [teams] = await pool.execute(`
            SELECT teamName
            FROM team
            ORDER BY teamId ASC
        `);

        console.log('DEBUG: rendering teams view, teams count=', teams.length);
        res.render('teams', { teams });
    } catch (err) {
        console.error('Error loading teams:', err);
        res.status(500).send('Error loading teams');
    }
});

// =========================
// START SERVER
// =========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log(`Server is running on http://localhost:${PORT}`);
});
