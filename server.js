const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase setup
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- API Routes ---

// Get user data
app.get('/api/user/:name', async (req, res) => {
    const name = req.params.name.toLowerCase().trim();
    try {
        const { data, error } = await supabase
            .from('users')
            .select('data')
            .eq('name', name)
            .single();

        if (error && error.code === 'PGRST116') {
            // User not found, return empty
            return res.json({ chapters: [] });
        }
        if (error) throw error;

        res.json(data.data);
    } catch (err) {
        console.error('GET error:', err.message);
        res.status(500).json({ error: 'Fehler beim Laden' });
    }
});

// Save user data
app.put('/api/user/:name', async (req, res) => {
    const name = req.params.name.toLowerCase().trim();
    try {
        const { error } = await supabase
            .from('users')
            .upsert({ name, data: req.body, updated_at: new Date().toISOString() },
                     { onConflict: 'name' });

        if (error) throw error;

        res.json({ ok: true });
    } catch (err) {
        console.error('PUT error:', err.message);
        res.status(500).json({ error: 'Fehler beim Speichern' });
    }
});

// --- User Page Route ---
app.get('/user/:name', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Landing page
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Zaras Lernprogramm</title>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f1117; color: #e4e6f0;
            min-height: 100vh; display: flex; align-items: center; justify-content: center;
        }
        .container { text-align: center; padding: 40px; }
        h1 { font-size: 2rem; margin-bottom: 12px; color: #6c5ce7; }
        p { color: #8b8fa3; margin-bottom: 24px; }
        .form-row { display: flex; gap: 8px; justify-content: center; align-items: center; }
        input {
            padding: 12px 16px; background: #1a1d27; border: 1px solid #2a2e3d;
            border-radius: 8px; color: #e4e6f0; font-size: 1rem; width: 200px; outline: none;
        }
        input:focus { border-color: #6c5ce7; }
        button {
            padding: 12px 24px; background: #6c5ce7; color: white; border: none;
            border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer;
        }
        button:hover { background: #7d6ff0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Zaras Lernprogramm</h1>
        <p>Gib deinen Namen ein, um zu deinem Lernbereich zu gelangen.</p>
        <div class="form-row">
            <input type="text" id="nameInput" placeholder="z.B. emma" autofocus
                   onkeydown="if(event.key==='Enter')go()">
            <button onclick="go()">Los</button>
        </div>
    </div>
    <script>
        function go() {
            const name = document.getElementById('nameInput').value.trim().toLowerCase();
            if (name) window.location.href = '/user/' + encodeURIComponent(name);
        }
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server läuft auf http://localhost:${PORT}`);
});
