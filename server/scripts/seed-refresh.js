const axios = require('axios');
const fs = require('fs');
const path = require('path');

const tokenUrl = 'https://login.questrade.com/oauth2/token';
const refreshTokenInput = process.argv[2] || process.env.QUESTRADE_REFRESH_TOKEN;

if (!refreshTokenInput) {
  console.error('Usage: npm run seed-token -- <refreshToken>');
  process.exit(1);
}

(async () => {
  try {
    const response = await axios.get(tokenUrl, {
      params: {
        grant_type: 'refresh_token',
        refresh_token: refreshTokenInput,
      },
    });

    const data = response.data;
    console.log('Access token acquired. Writing new refresh token to token-store.json');
    console.log(JSON.stringify(data, null, 2));

    const tokenPath = path.join(process.cwd(), 'token-store.json');
    fs.writeFileSync(
      tokenPath,
      JSON.stringify(
        {
          refreshToken: data.refresh_token,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf-8'
    );

    console.log('token-store.json updated successfully.');
  } catch (error) {
    if (error.response) {
      console.error('Questrade response:', error.response.status, error.response.data);
    } else {
      console.error(error.message);
    }
    process.exit(1);
  }
})();
