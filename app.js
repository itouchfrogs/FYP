const path = require('path');
const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');

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

// =========================
// HOME
// =========================

app.get("/", (req, res) => {

    res.render("home");

});

// =========================
// SHOW ALL PLAYERS
// =========================

app.get('/players', async (req, res) => {
    try {
        const [players] = await pool.execute(`
            SELECT playerId, name, age, email, username, teamName, role
            FROM player
            ORDER BY teamName ASC
        `);

        res.render('players', { players });
    } catch (err) {
        console.error('Error loading players:', err);
        res.status(500).send('Error loading players');
    }
});

// =========================
// ADD PLAYER PAGE
// =========================

app.get("/players/add", async (req, res) => {

    try {

        const [teams] = await pool.execute(`
            SELECT DISTINCT teamName
            FROM player
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

app.post("/players/add", async (req, res) => {

    try {

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
                country,
                teamName,
                role,
                password

            )

            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

        `, [

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

    try {

        const { playerId } = req.params;

        await pool.execute(
            `DELETE FROM player WHERE playerId = ?`,
            [playerId]
        );

        res.redirect('/players');

    } catch (err) {

        console.error(err);

        res.status(500).send("Error deleting player");

    }

});

// =========================
// START SERVER
// =========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log(`Server is running on http://localhost:${PORT}`);

});
// Examples
// console.log(generalize(20));
// console.log(encrypt('G3608370R'));
// console.log(tokenize("cheeseburger"));
// console.log(swap('west'));
// console.log(dpInt(4200)); 
// console.log(mask('bob@gmail.com'));
