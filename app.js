const path = require('path');
const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs');
const https = require('https');

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

const ocrUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype || !file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'));
        }
        cb(null, true);
    }
});

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

    // Keep below provider max_user_connections (currently 5).
    connectionLimit: Number(process.env.DB_POOL_CONNECTION_LIMIT || 4),

    queueLimit: 0,

    connectTimeout: 10000

}).promise();

async function ensurePlayerSchema() {
    try {
        const [serverColumns] = await pool.execute("SHOW COLUMNS FROM player LIKE 'originalServerId'");
        if (serverColumns.length === 0) {
            await pool.execute(`
                ALTER TABLE player
                ADD COLUMN originalServerId VARCHAR(255) NULL AFTER serverId
            `);

            // Backfill with current serverId where possible (true original values
            // are not recoverable for old rows once anonymized).
            await pool.execute(`
                UPDATE player
                SET originalServerId = CAST(serverId AS CHAR)
                WHERE originalServerId IS NULL
            `);

            console.log('Schema update: added originalServerId to player table');
        }

        const [dobColumns] = await pool.execute("SHOW COLUMNS FROM player LIKE 'originalDob'");
        if (dobColumns.length === 0) {
            await pool.execute(`
                ALTER TABLE player
                ADD COLUMN originalDob VARCHAR(255) NULL AFTER dateOfBirth
            `);

            await pool.execute(`
                UPDATE player
                SET originalDob = CAST(dateOfBirth AS CHAR)
                WHERE originalDob IS NULL AND dateOfBirth IS NOT NULL
            `);

            console.log('Schema update: added originalDob to player table');
        }
    } catch (err) {
        console.error('Schema check/update failed for player table:', err);
        throw err;
    }
}

async function ensureConsentSchema() {
    try {
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS consent_records (
                consentId INT AUTO_INCREMENT PRIMARY KEY,
                subjectIdentifier VARCHAR(255) NULL,
                fullName VARCHAR(255) NULL,
                contactEmail VARCHAR(255) NULL,
                age INT NULL,
                parentalPermissionGiven TINYINT(1) NOT NULL DEFAULT 0,
                parentalFullName VARCHAR(255) NULL,
                parentalPhone VARCHAR(50) NULL,
                purposes TEXT NOT NULL,
                consentVersion VARCHAR(50) NOT NULL,
                consentedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const [subjectTypeColumns] = await pool.execute("SHOW COLUMNS FROM consent_records LIKE 'subjectType'");
        if (subjectTypeColumns.length > 0) {
            await pool.execute('ALTER TABLE consent_records DROP COLUMN subjectType');
        }

        const [ipColumns] = await pool.execute("SHOW COLUMNS FROM consent_records LIKE 'ipAddress'");
        if (ipColumns.length > 0) {
            await pool.execute('ALTER TABLE consent_records DROP COLUMN ipAddress');
        }

        const [userAgentColumns] = await pool.execute("SHOW COLUMNS FROM consent_records LIKE 'userAgent'");
        if (userAgentColumns.length > 0) {
            await pool.execute('ALTER TABLE consent_records DROP COLUMN userAgent');
        }

        const [ageColumns] = await pool.execute("SHOW COLUMNS FROM consent_records LIKE 'age'");
        const [legacyAgeColumns] = await pool.execute("SHOW COLUMNS FROM consent_records LIKE 'ageYears'");

        if (ageColumns.length === 0) {
            await pool.execute('ALTER TABLE consent_records ADD COLUMN age INT NULL AFTER contactEmail');
        }

        if (legacyAgeColumns.length > 0) {
            await pool.execute('UPDATE consent_records SET age = ageYears WHERE age IS NULL AND ageYears IS NOT NULL');
            await pool.execute('ALTER TABLE consent_records DROP COLUMN ageYears');
        }

        const [parentalPermissionColumns] = await pool.execute("SHOW COLUMNS FROM consent_records LIKE 'parentalPermissionGiven'");
        if (parentalPermissionColumns.length === 0) {
            await pool.execute('ALTER TABLE consent_records ADD COLUMN parentalPermissionGiven TINYINT(1) NOT NULL DEFAULT 0 AFTER age');
        }

        const [parentalNameColumns] = await pool.execute("SHOW COLUMNS FROM consent_records LIKE 'parentalFullName'");
        if (parentalNameColumns.length === 0) {
            await pool.execute('ALTER TABLE consent_records ADD COLUMN parentalFullName VARCHAR(255) NULL AFTER parentalPermissionGiven');
        }

        const [parentalPhoneColumns] = await pool.execute("SHOW COLUMNS FROM consent_records LIKE 'parentalPhone'");
        if (parentalPhoneColumns.length === 0) {
            await pool.execute('ALTER TABLE consent_records ADD COLUMN parentalPhone VARCHAR(50) NULL AFTER parentalFullName');
        }
    } catch (err) {
        console.error('Schema check/update failed for consent_records table:', err);
        throw err;
    }
}

// =========================
// SETTINGS
// =========================

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));

app.use(express.urlencoded({ extended: false }));

const CONSENT_VERSION = 'PDPC-CONSENT-v1';

function getSafeReturnTo(value) {
    if (!value || typeof value !== 'string') {
        return '/';
    }

    if (value.startsWith('/') && !value.startsWith('//')) {
        return value;
    }

    return '/';
}

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
const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = crypto
    .createHash('sha256')
    .update(process.env.DATA_ENCRYPTION_KEY || 'fyp-default-data-key')
    .digest();

function encrypt(value) {
    if (value === null || value === undefined || value === '') {
        return value;
    }

    // Keep compatibility with existing stored format in DB.
    return Buffer.from(String(value), 'utf8').toString('base64');
}

function decrypt(value) {
    if (value === null || value === undefined || value === '') {
        return value;
    }

    const text = String(value);
    const parts = text.split(':');
    if (parts.length === 2 && parts[0] && parts[1]) {
        try {
            const iv = Buffer.from(parts[0], 'hex');
            const encryptedText = Buffer.from(parts[1], 'hex');
            const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
            const decrypted = Buffer.concat([
                decipher.update(encryptedText),
                decipher.final()
            ]);
            return decrypted.toString('utf8');
        } catch (err) {
            // Continue to Base64 fallback below.
        }
    }

    try {
        const decoded = Buffer.from(text, 'base64').toString('utf8');
        const normalizedInput = text.replace(/=+$/, '');
        const normalizedDecoded = Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '');
        return normalizedInput === normalizedDecoded ? decoded : text;
    } catch (err) {
        return text;
    }
}

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
async function saveAddressToVault(realAddress, db = pool) {
    let token = generateAddressToken(16);

    while (true) {
        try {
            await db.execute(
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

async function rebuildSwappedRegions(db) {
    // [SWAP-1] Load current real regions for all players.
    const [players] = await db.execute(`
        SELECT playerId, region
        FROM player
        ORDER BY playerId ASC
    `);

    if (players.length === 0) {
        return { isAvailable: false, reason: 'no-data' };
    }

    const normalizedPlayers = players.map((player) => ({
        playerId: player.playerId,
        region: typeof player.region === 'string' ? player.region.trim() : player.region
    }));

    // [SWAP-2] Build a candidate set containing only players with non-empty regions.
    const playersWithRegion = normalizedPlayers.filter((player) => player.region);
    const swappedRegionById = new Map();

    if (playersWithRegion.length > 0) {
        // [SWAP-3] Count each real region to check if a valid swapped mapping is possible.
        const regionCounts = new Map();
        for (const player of playersWithRegion) {
            regionCounts.set(player.region, (regionCounts.get(player.region) || 0) + 1);
        }

        // [SWAP-4] If one region dominates too much, we cannot keep every swapped value different.
        const maxRegionCount = Math.max(...regionCounts.values());
        if (maxRegionCount > Math.floor(playersWithRegion.length / 2)) {
            // [SWAP-5] Mark swapped regions unavailable (null) to avoid inaccurate statistics.
            for (const player of normalizedPlayers) {
                await db.execute(
                    'UPDATE player SET swappedRegion = ? WHERE playerId = ?',
                    [null, player.playerId]
                );
            }

            return {
                isAvailable: false,
                reason: 'insufficient-balance'
            };
        }

        // [SWAP-6] Sort players deterministically before shifted assignment.
        const sortedPlayers = [...playersWithRegion].sort((left, right) => {
            const regionCompare = left.region.localeCompare(right.region);
            if (regionCompare !== 0) {
                return regionCompare;
            }

            return left.playerId - right.playerId;
        });

        // [SWAP-7] Shift by the dominant-region count to create a count-preserving derangement.
        const shift = maxRegionCount;
        for (let index = 0; index < sortedPlayers.length; index += 1) {
            const currentPlayer = sortedPlayers[index];
            const shiftedPlayer = sortedPlayers[(index + shift) % sortedPlayers.length];
            swappedRegionById.set(currentPlayer.playerId, shiftedPlayer.region);
        }
    }

    // [SWAP-8] Persist swappedRegion for each player (or null when unavailable).
    for (const player of normalizedPlayers) {
        const swappedRegionValue = swappedRegionById.has(player.playerId)
            ? swappedRegionById.get(player.playerId)
            : null;

        await db.execute(
            'UPDATE player SET swappedRegion = ? WHERE playerId = ?',
            [swappedRegionValue, player.playerId]
        );
    }

    return {
        isAvailable: playersWithRegion.length > 0,
        reason: playersWithRegion.length > 0 ? null : 'no-region-data'
    };
}

// Session middleware
app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 1 week
}));

function getSessionRole(sessionObj) {
    if (!sessionObj) {
        return null;
    }

    if (sessionObj.role === 'admin' || sessionObj.role === 'employee' || sessionObj.role === 'player') {
        return sessionObj.role;
    }

    if (sessionObj.playerId) {
        return 'player';
    }

    return null;
}

function getDashboardPathByRole(role) {
    if (role === 'admin') {
        return '/adminpage';
    }

    if (role === 'employee') {
        return '/employeepage';
    }

    if (role === 'player') {
        return '/playerpage';
    }

    return null;
}

function redirectToRoleDashboard(req, res) {
    const role = getSessionRole(req.session);
    const dashboardPath = getDashboardPathByRole(role);

    if (dashboardPath) {
        return res.redirect(dashboardPath);
    }

    return null;
}

app.use((req, res, next) => {
    const currentRole = getSessionRole(req.session);
    const dashboardPath = getDashboardPathByRole(currentRole);

    res.locals.currentRole = currentRole;
    res.locals.isLoggedIn = Boolean(dashboardPath);
    res.locals.dashboardPath = dashboardPath;

    next();
});

function requireAdmin(req, res, next) {
    if (req.session && req.session.role === 'admin') {
        return next();
    }
    return res.redirect('/login');
}

function requireEmployee(req, res, next) {
    if (req.session && req.session.role === 'employee') {
        return next();
    }
    return res.redirect('/employeelogin');
}

function requireConsent(req, res, next) {
    if (req.session && req.session.pdpcConsentAccepted === true) {
        return next();
    }

    const returnTo = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/consent?returnTo=${returnTo}`);
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

function extractProfileFieldsFromText(rawText) {
    const text = String(rawText || '').replace(/\r/g, '\n');
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    let username = '';
    let accountId = '';
    let serverId = '';

    function pickLikelyUsernameFromLine(line) {
        const cleaned = String(line || '').replace(/[^\w\s.-]/g, ' ').trim();
        if (!cleaned) {
            return '';
        }

        const tokens = cleaned.match(/[A-Za-z0-9_.-]{4,24}/g) || [];
        const blocked = /^(profile|settings|album|history|battlefield|info|collection|social|account|edit|rank|live)$/i;
        const candidates = tokens.filter((token) => {
            if (!/[A-Za-z]/.test(token)) {
                return false;
            }

            if (blocked.test(token)) {
                return false;
            }

            return true;
        });

        if (candidates.length === 0) {
            return '';
        }

        const scored = candidates
            .map((token) => {
                const hasLower = /[a-z]/.test(token) ? 2 : 0;
                const hasDigit = /\d/.test(token) ? 1 : 0;
                const notAllCaps = /[A-Z]/.test(token) && /[a-z]/.test(token) ? 2 : 0;
                const hasXPattern = /(x{2,}|X{2,})/.test(token) ? 2 : 0;
                const lenScore = Math.min(token.length, 12) / 12;
                return { token, score: hasLower + hasDigit + notAllCaps + hasXPattern + lenScore };
            })
            .sort((a, b) => b.score - a.score);

        return scored[0].token;
    }

    // Example profile line: ID: 428718118 (9956)
    // OCR can misread "ID" as "ip", "1D", or "lD".
    const idMatch = text.match(/(?:\b(?:id|ip|1d|ld)\b\s*[:\-]?\s*)?(\d{6,})\s*[\(\[]\s*(\d{3,6})\s*[\)\]]/i);
    if (idMatch) {
        accountId = idMatch[1];
        serverId = idMatch[2];

        const idLineIndex = lines.findIndex((line) =>
            /(?:(?:id|ip|1d|ld)\s*[:\-]?\s*)?\d{6,}\s*[\(\[]\s*\d{3,6}\s*[\)\]]/i.test(line)
        );

        if (idLineIndex >= 0) {
            const start = Math.max(0, idLineIndex - 3);
            const nearby = lines.slice(start, idLineIndex + 1);
            for (let i = nearby.length - 1; i >= 0; i--) {
                const candidate = pickLikelyUsernameFromLine(nearby[i]);
                if (candidate) {
                    username = candidate;
                    break;
                }
            }
        }
    }

    if (!accountId || !serverId) {
        const fallbackPair = text.match(/\b(\d{6,})\s*[\(\[]\s*(\d{3,6})\s*[\)\]]\b/);
        if (fallbackPair) {
            accountId = accountId || fallbackPair[1];
            serverId = serverId || fallbackPair[2];
        }
    }

    if (!username) {
        const usernameMatch = text.match(/(?:IGN|Username|In-game\s*Name|Name)\s*[:\-]\s*([A-Za-z0-9_.\- ]{3,})/i);
        if (usernameMatch) {
            username = usernameMatch[1].trim();
        }
    }

    if (!username) {
        const bestLine = lines.find((line) => /(dex|ign|username|name)/i.test(line));
        const fallbackName = pickLikelyUsernameFromLine(bestLine || '');
        if (fallbackName) {
            username = fallbackName;
        }
    }

    if (!username) {
        const idLine = lines.find((line) => /\d{6,}\s*[\(\[]\s*\d{3,6}\s*[\)\]]/.test(line));
        if (idLine) {
            const idIndex = lines.indexOf(idLine);
            const nearby = lines.slice(Math.max(0, idIndex - 3), idIndex + 1);
            for (let i = nearby.length - 1; i >= 0; i--) {
                const candidate = pickLikelyUsernameFromLine(nearby[i]);
                if (candidate) {
                    username = candidate;
                    break;
                }
            }
        }
    }

    return { username, accountId, serverId };
}

app.get("/", async (req, res) => {

    try {
        const [teams] = await pool.execute(`
            SELECT DISTINCT teamName
            FROM teams
            WHERE teamName IS NOT NULL
            AND teamName != ''
            ORDER BY teamName ASC
        `);

        const [regionRows] = await pool.execute(`
            SELECT region, swappedRegion
            FROM player
            WHERE (region IS NOT NULL AND region != '')
               OR (swappedRegion IS NOT NULL AND swappedRegion != '')
        `);

        // [STAT-1] Count real-region and swapped-region totals independently.
        const realRegionCounts = new Map();
        const swappedRegionCounts = new Map();

        for (const row of regionRows) {
            const realRegion = typeof row.region === 'string' ? row.region.trim() : '';
            const swappedRegion = typeof row.swappedRegion === 'string' ? row.swappedRegion.trim() : '';

            if (realRegion) {
                realRegionCounts.set(realRegion, (realRegionCounts.get(realRegion) || 0) + 1);
            }

            if (swappedRegion) {
                swappedRegionCounts.set(swappedRegion, (swappedRegionCounts.get(swappedRegion) || 0) + 1);
            }
        }

        const allRegions = Array.from(new Set([
            ...realRegionCounts.keys(),
            ...swappedRegionCounts.keys()
        ])).sort((left, right) => left.localeCompare(right));

        // [STAT-2] Merge both maps into one view model for graph rendering.
        const regionStats = allRegions.map((regionName) => ({
            region: regionName,
            realCount: realRegionCounts.get(regionName) || 0,
            swappedCount: swappedRegionCounts.get(regionName) || 0
        }));

        // [STAT-3] Graph is shown only when swapped totals remain true to real totals.
        const regionStatsVerified = regionStats.every((entry) => entry.realCount === entry.swappedCount);
        const regionStatsAvailable = regionStatsVerified
            && regionStats.length > 0
            && regionStats.every((entry) => entry.swappedCount > 0);
        const regionStatsMessage = regionStatsAvailable
            ? 'Using swapped-region totals verified against real-region totals.'
            : 'Information not available yet. Add or remove more player data until swapped-region statistics can match the real region totals accurately.';

        const hasActiveSession = Boolean(
            req.session
            && (
                req.session.playerId
                || req.session.employeeId
                || req.session.adminId
                || req.session.role
            )
        );

        res.render("home", {
            teams,
            showConsentCta: !hasActiveSession,
            regionStats,
            regionStatsVerified,
            regionStatsAvailable,
            regionStatsMessage
        });
    } catch (err) {
        console.error('Error loading home page teams:', err);
        res.status(500).send('Error loading home page');
    }

});

// =========================
// LOGIN PAGE
// =========================

app.get('/login', (req, res) => {
    if (redirectToRoleDashboard(req, res)) {
        return;
    }

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
        let match = false;

        try {
            match = await bcrypt.compare(password, admin.password);
        } catch (error) {
            match = false;
        }

        if (!match && password === admin.password) {
            match = true;
        }

        if (!match) {
            return res.status(401).send('Invalid username or password');
        }

        if (admin.role && admin.role !== 'admin' && admin.role !== 'employee') {
            return res.status(403).send('User does not have access');
        }

        req.session.adminId = admin.adminId;
        delete req.session.employeeId;
        delete req.session.playerId;
        delete req.session.playerUsername;
        delete req.session.playerEmail;
        req.session.role = admin.role || 'admin';

        console.log('DEBUG LOGIN: Session set - adminId=', req.session.adminId, 'role=', req.session.role);

        res.redirect(admin.role === 'employee' ? '/employeepage' : '/adminpage');
    } catch (err) {
        console.error(err);
        res.status(500).send('Login error');
    }
});

app.get('/playerlogin', (req, res) => {
    if (redirectToRoleDashboard(req, res)) {
        return;
    }

    res.render('playerlogin');
});

app.get('/loginlist', (req, res) => {
    if (redirectToRoleDashboard(req, res)) {
        return;
    }

    res.render('loginlist');
});

app.get('/consent', (req, res) => {
    const returnTo = getSafeReturnTo(req.query.returnTo);
    res.render('consent', {
        returnTo,
        consentVersion: CONSENT_VERSION,
        consentError: null,
        consentForm: {
            fullName: '',
            contactEmail: '',
            age: '',
            parentalPermission: false,
            parentalFullName: '',
            parentalPhone: '',
            consentPurpose: [],
            acknowledgeNotice: false,
            consentCollectionUse: false,
            consentDisclosure: false,
            confirmAge: false
        }
    });
});

app.post('/consent', async (req, res) => {
    const returnTo = getSafeReturnTo(req.body.returnTo || req.query.returnTo);

    try {
        const {
            fullName,
            contactEmail,
            age,
            parentalPermission,
            parentalFullName,
            parentalPhone,
            acknowledgeNotice,
            consentCollectionUse,
            consentDisclosure,
            confirmAge,
            consentPurpose
        } = req.body;

        const selectedPurposes = Array.isArray(consentPurpose)
            ? consentPurpose.filter(Boolean)
            : consentPurpose
                ? [consentPurpose]
                : [];

        const consentForm = {
            fullName: String(fullName || ''),
            contactEmail: String(contactEmail || ''),
            age: String(age || ''),
            parentalPermission: parentalPermission === 'yes',
            parentalFullName: String(parentalFullName || ''),
            parentalPhone: String(parentalPhone || ''),
            consentPurpose: selectedPurposes,
            acknowledgeNotice: acknowledgeNotice === 'yes',
            consentCollectionUse: consentCollectionUse === 'yes',
            consentDisclosure: consentDisclosure === 'yes',
            confirmAge: confirmAge === 'yes'
        };

        const trimmedFullName = consentForm.fullName.trim();
        const trimmedContactEmail = consentForm.contactEmail.trim();
        consentForm.fullName = trimmedFullName;
        consentForm.contactEmail = trimmedContactEmail;

        const hasRequiredConsent =
            acknowledgeNotice === 'yes'
            && consentCollectionUse === 'yes'
            && consentDisclosure === 'yes'
            && confirmAge === 'yes'
            && selectedPurposes.length > 0;

        const parsedAge = Number.parseInt(age, 10);
        const isAgeValid = Number.isInteger(parsedAge) && parsedAge >= 0;

        if (!isAgeValid) {
            return res.status(400).render('consent', {
                returnTo,
                consentVersion: CONSENT_VERSION,
                consentError: 'Please provide a valid age.',
                consentForm
            });
        }

        if (!trimmedFullName || !trimmedContactEmail) {
            return res.status(400).render('consent', {
                returnTo,
                consentVersion: CONSENT_VERSION,
                consentError: 'Full name and contact email are required.',
                consentForm
            });
        }

        const isMinor = parsedAge < 18;
        const hasParentalPermission = parentalPermission === 'yes';
        const parentName = String(parentalFullName || '').trim();
        const parentPhone = String(parentalPhone || '').trim();

        if (!hasRequiredConsent) {
            return res.status(400).render('consent', {
                returnTo,
                consentVersion: CONSENT_VERSION,
                consentError: 'You must acknowledge all required consent checkboxes before continuing.',
                consentForm
            });
        }

        if (isMinor && (!hasParentalPermission || !parentName || !parentPhone)) {
            return res.status(400).render('consent', {
                returnTo,
                consentVersion: CONSENT_VERSION,
                consentError: 'For users under 18, parental permission, parent full name, and parent phone number are required.',
                consentForm
            });
        }

        const subjectIdentifier = req.session?.playerId
            ? `player:${req.session.playerId}`
            : req.session?.adminId
                ? `admin:${req.session.adminId}`
                : req.session?.employeeId
                    ? `employee:${req.session.employeeId}`
                    : trimmedContactEmail;

        await pool.execute(
            `INSERT INTO consent_records
                (subjectIdentifier, fullName, contactEmail, age, parentalPermissionGiven, parentalFullName, parentalPhone, purposes, consentVersion)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                subjectIdentifier,
                trimmedFullName,
                trimmedContactEmail,
                parsedAge,
                isMinor ? 1 : 0,
                isMinor ? parentName : null,
                isMinor ? encrypt(parentPhone) : null,
                JSON.stringify(selectedPurposes),
                CONSENT_VERSION
            ]
        );

        req.session.pdpcConsentAccepted = true;
        req.session.pdpcConsentAt = new Date().toISOString();
        req.session.pdpcConsentVersion = CONSENT_VERSION;

        return res.redirect(returnTo);
    } catch (err) {
        console.error('Consent submission error:', err);
        return res.status(500).render('consent', {
            returnTo,
            consentVersion: CONSENT_VERSION,
            consentError: 'Failed to record consent. Please try again.',
            consentForm: {
                fullName: String(req.body?.fullName || ''),
                contactEmail: String(req.body?.contactEmail || ''),
                age: String(req.body?.age || ''),
                parentalPermission: req.body?.parentalPermission === 'yes',
                parentalFullName: String(req.body?.parentalFullName || ''),
                parentalPhone: String(req.body?.parentalPhone || ''),
                consentPurpose: Array.isArray(req.body?.consentPurpose)
                    ? req.body.consentPurpose
                    : req.body?.consentPurpose
                        ? [req.body.consentPurpose]
                        : [],
                acknowledgeNotice: req.body?.acknowledgeNotice === 'yes',
                consentCollectionUse: req.body?.consentCollectionUse === 'yes',
                consentDisclosure: req.body?.consentDisclosure === 'yes',
                confirmAge: req.body?.confirmAge === 'yes'
            }
        });
    }
});

function requirePlayer(req, res, next) {
    if (req.session && req.session.role === 'player' && req.session.playerId) {
        return next();
    }
    return res.redirect('/playerlogin');
}

app.get('/playerprofile', requirePlayer, async (req, res) => {
    try {
        const playerId = req.session.playerId;

        const [rows] = await pool.execute(
            'SELECT playerId, name, age, email, username, teamName, role, region, postalCode, country FROM player WHERE playerId = ? LIMIT 1',
            [playerId]
        );

        if (rows.length === 0) {
            return res.status(404).send('Player profile not found');
        }

        res.render('playerprofile', { player: rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading player profile');
    }
});

app.get('/playerprofile/edit', requirePlayer, async (req, res) => {
    try {
        const playerId = req.session.playerId;

        const [teams] = await pool.execute(`
            SELECT DISTINCT teamName
            FROM teams
            WHERE teamName IS NOT NULL
            AND teamName != ''
            ORDER BY teamName ASC
        `);

        const [rows] = await pool.execute(
            'SELECT playerId, name, age, dateOfBirth, email, username, teamName, role, region, postalCode, country FROM player WHERE playerId = ? LIMIT 1',
            [playerId]
        );

        if (rows.length === 0) {
            return res.status(404).send('Player profile not found');
        }

        res.render('editplayerprofile', { player: rows[0], teams });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading player edit page');
    }
});

app.post('/playerprofile/edit', requirePlayer, async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const playerId = req.session.playerId;
        const { name, age, dateOfBirth, email, username, teamName, role, region, postalCode, country } = req.body;

        await connection.beginTransaction();

        await connection.execute(
            `UPDATE player SET name = ?, age = ?, dateOfBirth = ?, email = ?, username = ?, teamName = ?, role = ?, region = ?, postalCode = ?, country = ? WHERE playerId = ?`,
            [name, age, dateOfBirth, email, username, teamName, role, region, postalCode, country, playerId]
        );

        await rebuildSwappedRegions(connection);

        await connection.commit();

        req.session.playerUsername = username;
        req.session.playerEmail = email;

        res.redirect('/playerprofile');
    } catch (err) {
        await connection.rollback();
        console.error(err);
        if (err.code === 'SWAPPED_REGION_DERANGEMENT_IMPOSSIBLE') {
            return res.status(400).send(err.message);
        }
        res.status(500).send('Error updating player profile');
    } finally {
        connection.release();
    }
});

app.get('/playerpage', requirePlayer, (req, res) => {
    res.render('playerpage');
});

app.get('/adminpage', requireAdmin, (req, res) => {
    res.render('adminpage');
});

app.get('/employeelogin', (req, res) => {
    if (redirectToRoleDashboard(req, res)) {
        return;
    }

    res.render('employeelogin', { error: null });
});

app.post('/employeelogin', async (req, res) => {
    try {
        const { name, password } = req.body;

        const [rows] = await pool.execute(
            `SELECT adminId AS employeeId, username AS name, password, role
             FROM admin
             WHERE username = ? AND role = 'employee'
             LIMIT 1`,
            [name]
        );

        if (rows.length === 0) {
            return res.render('employeelogin', { error: 'Invalid name or password' });
        }

        const user = rows[0];

        let match = false;
        try {
            match = await bcrypt.compare(password, user.password);
        } catch (e) {
            match = false;
        }
        if (!match && password === user.password) {
            match = true;
        }

        if (!match) {
            return res.render('employeelogin', { error: 'Invalid name or password' });
        }

        req.session.employeeId = user.employeeId;
        delete req.session.adminId;
        delete req.session.playerId;
        delete req.session.playerUsername;
        delete req.session.playerEmail;
        req.session.role = 'employee';

        res.redirect('/employeepage');
    } catch (err) {
        console.error(err);
        res.status(500).send('Employee login error');
    }
});

app.get('/employeepage', requireEmployee, (req, res) => {
    res.render('employeepage');
});

app.post('/playerlogin', async (req, res) => {
    try {
        const { email, password } = req.body;

        const [rows] = await pool.execute(
            'SELECT playerId, username, email, password FROM player WHERE email = ? LIMIT 1',
            [email]
        );

        if (rows.length === 0) {
            return res.status(401).send('Invalid email or password');
        }

        const player = rows[0];
        const match = await bcrypt.compare(password, player.password).catch(() => false);
        const passwordValid = match || password === player.password;

        if (!passwordValid) {
            return res.status(401).send('Invalid email or password');
        }

        req.session.playerId = player.playerId;
        delete req.session.adminId;
        delete req.session.employeeId;
        req.session.playerUsername = player.username;
        req.session.playerEmail = player.email;
        req.session.role = 'player';

        res.redirect('/playerpage');
    } catch (err) {
        console.error(err);
        res.status(500).send('Player login error');
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
        const isAdmin = (req.session && req.session.role === 'admin') || false;
        console.log('DEBUG /players: isAdmin=', isAdmin, 'session=', req.session ? req.session.role : 'no session');
        res.render('players', { players, isAdmin: isAdmin });
    } catch (err) {
        console.error('Error loading players:', err);
        res.status(500).send('Error loading players');
    }
});

app.get('/playercheck', requireEmployee, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');

        const [rows] = await pool.execute(`
            SELECT
                p.playerId,
                p.name,
                p.age,
                p.dateOfBirth,
                p.originalDob,
                DATE_FORMAT(p.dateOfBirth, '%Y-%m-%d') AS formattedDateOfBirth,
                p.ic,
                p.phoneNumber,
                p.email,
                p.username,
                p.accountId,
                p.serverId,
                p.address AS addressToken,
                av.real_address AS address,
                p.postalCode,
                p.region,
                p.swappedRegion,
                p.country,
                p.teamName,
                p.role
            FROM player p
            LEFT JOIN address_vault av ON p.address = av.token
            ORDER BY p.teamName ASC, p.name ASC
        `);

        const players = rows.map((player) => {
            const resolvedDateOfBirth = player.originalDob
                || (typeof player.formattedDateOfBirth === 'string' && player.formattedDateOfBirth !== ''
                    ? player.formattedDateOfBirth
                    : player.dateOfBirth
                        ? new Date(player.dateOfBirth).toISOString().split('T')[0]
                        : '');

            return {
                ...player,
                dateOfBirth: resolvedDateOfBirth,
                formattedDateOfBirth: resolvedDateOfBirth,
                ic: decrypt(player.ic),
                phoneNumber: decrypt(player.phoneNumber)
            };
        });

        res.render('playercheck', { players });
    } catch (err) {
        console.error('Error loading playercheck:', err);
        res.status(500).send('Error loading player check page');
    }
});

app.get('/playerinfo', requireAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT
                p.*,
                DATE_FORMAT(p.dateOfBirth, '%Y-%m-%d') AS formattedDateOfBirth,
                av.real_address AS realAddress
            FROM player p
            LEFT JOIN address_vault av ON p.address = av.token
            ORDER BY p.teamName ASC, p.name ASC
        `);

        const players = rows.map((player) => ({
            ...player,
            dateOfBirth: typeof player.formattedDateOfBirth === 'string'
                ? player.formattedDateOfBirth
                : player.dateOfBirth
                    ? new Date(player.dateOfBirth).toISOString().split('T')[0]
                    : '',
            formattedDateOfBirth: typeof player.formattedDateOfBirth === 'string'
                ? player.formattedDateOfBirth
                : player.dateOfBirth
                    ? new Date(player.dateOfBirth).toISOString().split('T')[0]
                    : '',
            ic: decrypt(player.ic),
            phoneNumber: decrypt(player.phoneNumber)
        }));

        res.render('playerinfo', { players });
    } catch (err) {
        console.error('Error loading playerinfo:', err);
        res.status(500).send('Error loading player info page');
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
            FROM teams
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
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // normalize/move region fields if provided under different names
        moveFieldToEnd(req.body, 'region');
        moveFieldToEnd(req.body, 'singaporeRegion');

        const {
            ic,
            name,
            age,
            dateOfBirth,
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
        const normalizedAccountId = typeof accountId === 'string' ? accountId.trim() : '';
        const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
        const originalServerId = normalizedServerId || null;
        const noisedServerId = normalizedServerId ? dpServerId(normalizedServerId) : null;
        const originalDob = dateOfBirth;
        const dbDob = "1967-06-07";
        const addressToken = await saveAddressToVault(address, connection);
        const hashedPassword = await bcrypt.hash(password, 10);
        const encryptedIC = encrypt(ic);
        const encryptedPhone = encrypt(phoneNumber);

        await connection.execute(`

            INSERT INTO player (
                ic,
                name,
                age,
                dateOfBirth,
                originalDob,
                phoneNumber,
                email,
                username,
                accountId,
                serverId,
                originalServerId,
                address,
                postalCode,
                region,
                swappedRegion,
                country,
                teamName,
                role,
                password

            )

            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

        `, [
            encryptedIC,
            name,
            age,
            dbDob,
            originalDob,
            encryptedPhone,
            email,
            username,
            normalizedAccountId || null,
            noisedServerId,
            originalServerId,
            addressToken,
            postalCode,
            regionValue,
            regionValue,
            country,
            teamName,
            role,
            hashedPassword

        ]);

        await rebuildSwappedRegions(connection);

        await connection.commit();

        res.redirect("/players");

    } catch (err) {
        await connection.rollback();

        console.error(err);

        if (err.code === 'SWAPPED_REGION_DERANGEMENT_IMPOSSIBLE') {
            return res.status(400).send(err.message);
        }

        res.status(500).send("Error adding player");

    } finally {
        connection.release();

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
            'SELECT address FROM player WHERE playerId = ? FOR UPDATE',
            [playerId]
        );

        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).send('Player not found');
        }

        if (rows[0].address) {
            await connection.execute(
                `DELETE av
                 FROM address_vault av
                 INNER JOIN player p ON p.address = av.token
                 WHERE p.playerId = ?`,
                [playerId]
            );
        }

        await connection.execute(
            'DELETE FROM player WHERE playerId = ?',
            [playerId]
        );

        await rebuildSwappedRegions(connection);

        await connection.commit();
        res.redirect('/players');
    } catch (err) {
        await connection.rollback();
        console.error(err);
        if (err.code === 'SWAPPED_REGION_DERANGEMENT_IMPOSSIBLE') {
            return res.status(400).send(err.message);
        }
        res.status(500).send('Error deleting player');
    } finally {
        connection.release();
    }
});

app.post('/teams/delete', requireAdmin, async (req, res) => {
    try {
        const { teamId, teamName } = req.body;

        if (teamId) {
            await pool.execute(
                `DELETE FROM teams WHERE teamId = ?`,
                [teamId]
            );
        } else if (teamName) {
            await pool.execute(
                `DELETE FROM teams WHERE teamName = ? LIMIT 1`,
                [teamName]
            );
        } else {
            return res.status(400).send('Missing team identifier');
        }

        res.redirect('/teams');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error deleting team");
    }
});

app.get('/teams/delete', requireAdmin, (req, res) => {
    res.redirect('/teams');
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
            `INSERT INTO teams (teamName) VALUES (?)`,
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
            SELECT teamId, teamName
            FROM teams
            ORDER BY teamName ASC
        `);

        console.log('DEBUG: rendering teams view, teams count=', teams.length);
        res.render('teams', { teams });
    } catch (err) {
        console.error('Error loading teams:', err);
        res.status(500).send('Error loading teams');
    }
});

// =========================
// ADD ADMIN ACCOUNT PAGE
// =========================


app.get("/admins/add", requireAdmin, (req, res) => {
    try {
        res.render("addadmin");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading add admin account page");
    }
});

// =========================
// ADD ADMIN ACCOUNT
// =========================

app.post("/admins/add", requireAdmin, async (req, res) => {
    try {
        const { username, password, role } = req.body;

        // Validate inputs
        if (!username || !password || !role) {
            return res.status(400).send("Username, password, and role are required");
        }

        // Validate role
        if (role !== 'admin' && role !== 'player') {
            return res.status(400).send("Role must be 'admin' or 'player'");
        }

        // Check if username already exists
        const [existing] = await pool.execute(
            'SELECT adminId FROM admin WHERE username = ?',
            [username]
        );

        if (existing.length > 0) {
            return res.status(400).send("Username already exists");
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert new admin account
        await pool.execute(
            'INSERT INTO admin (username, password, role) VALUES (?, ?, ?)',
            [username, hashedPassword, role]
        );

        res.redirect("/admins");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error adding admin account");
    }
});

// =================--------
// SHOW ALL ADMINS
// =========================


app.get('/admins', requireAdmin, async (req, res) => {
    try {
        const [admins] = await pool.execute(`
            SELECT adminId, username, role
            FROM admin
            ORDER BY adminId ASC
        `);

        console.log('DEBUG: rendering admins view, admins count=', admins.length);
        res.render('admins', { admins });
    } catch (err) {
        console.error('Error loading admins:', err);
        res.status(500).send('Error loading admins');
    }
});

app.get('/consent-records', requireAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT
                consentId,
                subjectIdentifier,
                fullName,
                contactEmail,
                age,
                parentalPermissionGiven,
                parentalFullName,
                parentalPhone,
                purposes,
                consentVersion,
                consentedAt
            FROM consent_records
            ORDER BY consentedAt DESC
        `);

        const consentRecords = rows.map((record) => {
            let parsedPurposes = [];

            if (record.purposes) {
                try {
                    const parsed = JSON.parse(record.purposes);
                    parsedPurposes = Array.isArray(parsed) ? parsed : [String(parsed)];
                } catch (err) {
                    parsedPurposes = [String(record.purposes)];
                }
            }

            return {
                ...record,
                parentalPhone: decrypt(record.parentalPhone),
                parsedPurposes
            };
        });

        return res.render('consentrecords', {
            consentRecords
        });
    } catch (err) {
        console.error('Error loading consent records:', err);
        return res.status(500).send('Error loading consent records');
    }
});

app.post('/consent-records/delete/:consentId', requireAdmin, async (req, res) => {
    try {
        const { consentId } = req.params;

        await pool.execute(
            'DELETE FROM consent_records WHERE consentId = ?',
            [consentId]
        );

        return res.redirect('/consent-records');
    } catch (err) {
        console.error('Error deleting consent record:', err);
        return res.status(500).send('Error deleting consent record');
    }
});


// =========================
// DELETE ADMIN ACCOUNT
// =========================


app.post('/admins/delete/:adminId', requireAdmin, async (req, res) => {
    try {
        const { adminId } = req.params;

        // Prevent deleting yourself
        if (parseInt(adminId) === req.session.adminId) {
            return res.status(400).send("You cannot delete your own account");
        }

        await pool.execute(
            `DELETE FROM admin WHERE adminId = ?`,
            [adminId]
        );

        res.redirect('/admins');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error deleting admin account");
    }
});

// =========================
// START SERVER
// =========================

const ssl = {
    key: fs.readFileSync(path.join(__dirname, 'ssl', 'selfsigned.key')),
    cert: fs.readFileSync(path.join(__dirname, 'ssl', 'selfsigned.crt'))
};

const PORT = process.env.PORT || 443;

async function startServer() {
    await ensurePlayerSchema();
    await ensureConsentSchema();

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        await rebuildSwappedRegions(connection);
        await connection.commit();
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }

    https.createServer(ssl, app).listen(PORT, () => {
        console.log(`HTTPS server is running on https://localhost:${PORT}`);
    });

    const http = require('http');

    http.createServer((req, res) => {
        const host = req.headers.host || 'localhost';
        const redirectUrl = `https://${host}${req.url}`;

        res.writeHead(301, { Location: redirectUrl });
        res.end();
    }).listen(80, () => {
        console.log('HTTP redirect server is running on port 80');
    });
}

startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

async function shutdownServer(signal) {
    try {
        console.log(`${signal} received, closing MySQL pool...`);
        await pool.end();
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
}

process.on('SIGINT', () => shutdownServer('SIGINT'));
process.on('SIGTERM', () => shutdownServer('SIGTERM'));

app.post('/players/extract-image', requireAdmin, ocrUpload.single('profileImage'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }

        const processedBuffer = await sharp(req.file.buffer)
            .grayscale()
            .normalize()
            .sharpen()
            .png()
            .toBuffer();

        const worker = await createWorker('eng');
        const { data } = await worker.recognize(processedBuffer);
        await worker.terminate();

        const fields = extractProfileFieldsFromText(data.text || '');

        return res.json({
            fields,
            rawText: data.text || ''
        });
    } catch (err) {
        console.error('OCR extraction error:', err);
        return res.status(500).json({ error: 'Failed to extract profile info from image' });
    }
});
