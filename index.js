const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// Explicitly serve the HTML file from the 'public' folder on the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let users = {}; // apiKey -> user data

// Create API Key
app.post('/create-api', (req, res) => {
  const { gmail, appPass, upi } = req.body;
  if (!gmail || !appPass || !upi) {
    return res.json({ status: "error", message: "All fields required" });
  }

  const apiKey = "GMS" + Math.random().toString(36).substring(2, 15).toUpperCase();
  
  users[apiKey] = { gmail, appPass, upi }; // Orders hata diya kyunki ab direct UTR se check hoga

  res.json({ 
    status: "success", 
    apiKey,
    message: "API Created Successfully"
  });
});

// Generate QR (Ab sirf UPI ID aur Amount return karega)
app.get('/api/qr', (req, res) => {
  const apiKey = req.query.api;
  const amount = parseInt(req.query.amount) || 10;

  if (!users[apiKey]) {
    return res.json({ status: "error", message: "API Key Expire ho gayi hai! Website par jaakar nayi banayein." });
  }

  res.json({
    status: "success",
    data: {
      upi_id: users[apiKey].upi,
      amount: amount
    }
  });
});

// NAYA: Real Verify with IMAP using UTR/Transaction ID
app.get('/api/verify', async (req, res) => {
  const apiKey = req.query.api_key;
  const txnId = req.query.txn_id; // Frontend/Bot ab txn_id bhejega

  if (!users[apiKey]) {
    return res.json({ status: "error", message: "API Key Expire ho gayi hai!" });
  }
  if (!txnId) {
    return res.json({ status: "error", message: "Transaction ID is required" });
  }

  const user = users[apiKey];

  try {
    const result = await checkPaymentInEmail(user.gmail, user.appPass, txnId);
    
    if (result.status === "success") {
      res.json({
        status: "success",
        data: result.data
      });
    } else {
      res.json({
        status: "pending",
        message: "Payment not found or email is already read"
      });
    }
  } catch (err) {
    res.json({ status: "error", message: "Verification failed" });
  }
});

// NAYA IMAP Function: Direct UTR/Txn ID Search
async function checkPaymentInEmail(email, appPassword, txnId) {
  const imap = require('imap');
  const { simpleParser } = require('mailparser');
  const Imap = imap;

  return new Promise((resolve) => {
    const client = new Imap({
      user: email,
      password: appPassword,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { servername: 'imap.gmail.com' }
    });

    client.once('ready', () => {
      client.openBox('INBOX', true, (err, box) => {
        if (err) return resolve({ status: "pending" });

        // Email mein exactly user ka bheja hua Transaction ID/UTR dhoondhega
        const searchCriteria = ['UNSEEN', ['TEXT', txnId]];
        
        client.search(searchCriteria, (err, results) => {
          if (err || !results || results.length === 0) {
            client.end();
            return resolve({ status: "pending" });
          }

          const fetch = client.fetch(results, { bodies: '' });
          const emailPromises = [];

          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              emailPromises.push(new Promise((res) => {
                simpleParser(stream, (err, parsed) => {
                  res(parsed.text || "");
                });
              }));
            });
          });

          fetch.once('end', async () => {
            const emailsText = await Promise.all(emailPromises);
            let paymentFound = false;

            for (let text of emailsText) {
              if (text.includes(txnId)) {
                paymentFound = true;
                
                // Screenshot wale format se Amount aur Sender ka naam nikalna
                const amountMatch = text.match(/₹\s*([0-9]+(?:\.[0-9]+)?)/);
                const senderMatch = text.match(/from\s+([A-Za-z\s]+)/i);

                client.end();
                return resolve({
                  status: "success",
                  data: {
                    utr_or_txn: txnId,
                    amount: amountMatch ? parseFloat(amountMatch[1]) : 0,
                    sender: senderMatch ? senderMatch[1].trim() : "Unknown",
                  }
                });
              }
            }

            if (!paymentFound) {
              client.end();
              resolve({ status: "pending" });
            }
          });
        });
      });
    });

    client.once('error', () => resolve({ status: "pending" }));
    client.connect();
  });
}

// FIX FOR HEROKU: Yeh server ko bina kisi condition ke lagatar chalne dega
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GMS FamPay API running on port ${PORT}`);
});
