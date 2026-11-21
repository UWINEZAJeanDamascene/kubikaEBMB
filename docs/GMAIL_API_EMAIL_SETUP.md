# Gmail API email setup

Use the Gmail API provider when the hosting platform blocks outbound SMTP. It sends mail through Google's HTTPS API, so no custom sending domain is required. Mail is sent from the Gmail mailbox configured in `GMAIL_USER`.

## Google Cloud setup

1. Create a Google Cloud project and enable the **Gmail API**.
2. Configure Google Auth Platform. For a single mailbox owned by the app operator, choose **Personal** audience if available. Personal mode is limited to the account that created the app, but avoids the seven-day test-user authorization expiry.
3. Create an OAuth client ID for a **Web application**. If using OAuth 2.0 Playground to obtain the refresh token, add `https://developers.google.com/oauthplayground` as an authorized redirect URI.
4. Open [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/), open its settings, select **Use your own OAuth credentials**, and enter the client ID and secret. Set access type to **Offline** and force the consent screen.
5. In Step 1, enter `https://www.googleapis.com/auth/gmail.send`, authorize with the same Gmail account as `GMAIL_USER`, then exchange the authorization code in Step 2. Keep the refresh token private.

The Gmail send scope is sensitive. If using an **External** app in **Testing**, Google expires test-user authorizations (including refresh tokens) after seven days. Moving an External app to production can trigger OAuth verification requirements. Google documents the audience and expiration behavior [here](https://support.google.com/cloud/answer/15549945) and Gmail scope requirements [here](https://developers.google.com/workspace/gmail/api/auth/scopes).

OAuth Playground handles your OAuth credentials and token during the setup flow. Use only its official Google URL, never share a generated link containing credentials/tokens, and do not put credentials in source code or logs.

## Railway variables

Set these in the backend service's Railway Variables, then redeploy:

| Variable | Value |
| --- | --- |
| `EMAIL_PROVIDER` | `gmail-api` |
| `GMAIL_USER` | The Gmail mailbox authorized above |
| `GMAIL_API_CLIENT_ID` | OAuth client ID |
| `GMAIL_API_CLIENT_SECRET` | OAuth client secret |
| `GMAIL_API_REFRESH_TOKEN` | Refresh token from OAuth Playground |

Do not set `GMAIL_APP_PASSWORD` for this provider. `EMAIL_FROM_NAME` may be set to customize the display name; the sender address remains the authorized `GMAIL_USER`.

The backend refreshes short-lived access tokens automatically. If sending starts failing with an OAuth authorization error, confirm the refresh token is still valid, the mailbox matches `GMAIL_USER`, the Gmail API is enabled, and the token was authorized with the `gmail.send` scope. If it expired or was revoked, repeat the consent flow and update `GMAIL_API_REFRESH_TOKEN` in Railway.
