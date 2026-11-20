# Fujitsu-GAP Copilot Custom Model
日本語説明文は[後半](#japanese-description)にあります。

## English Description
This extension integrates Azure AD authentication for the GitHub Copilot Chat custom model, allowing users to leverage the Fujitsu-GAP custom model within VS Code.

## Features

- **Azure AD Integration**: Secure authentication using Azure Active Directory.
- **Custom Model Support**: Specifically designed for the Fujitsu-GAP custom model.
- **Configurable Tokens**: Ability to adjust maximum input tokens via settings.

## Configuration

To use this extension, please configure the following settings in VS Code:

- `fujitsuGap.tenantName`: Your Azure AD Tenant Name.
- `fujitsuGap.clientId`: Your Azure AD Client ID.
- `fujitsuGap.maxInputTokens`: Maximum input tokens (Default: 262144).
- `fujitsuGap.verboseLogging`: Enable MSAL verbose logs in the Developer Tools console (default: off). Changes apply without reloading. Filter for `Fujitsu-GAP MSAL`. PII logging is disabled; review logs before sharing and turn off after troubleshooting.

## Getting Started

1. Install the extension.
2. Open VS Code Settings (`Ctrl+,`).
3. Search for `Fujitsu-GAP` and fill in your tenant and client details.
4. Start chatting:
    - Open Copilot Chat.
    - In the model selection menu, select **"Fujitsu Cloud Service Generative AI Platform Custom Model"** from the **"Fujitsu-GAP"** group.

## Verification & Troubleshooting

OpenID metadata HTTP 403 responses show a VS Code error notification even when verbose logging is off. Menlo Security is identified only when its response headers explicitly indicate a block. Identical notifications are suppressed for 60 seconds; an HTTP 2xx response resets suppression.

With verbose logging enabled, `Fujitsu-GAP MSAL HTTP` entries summarize OpenID metadata responses: HTTP status, content type, body type, required field presence, and a restricted-format error code. HTTP diagnostics do not log URLs, full bodies, cookies, authentication headers, or tokens, and do not change transport or retries.

`menloHeaders.dispositionPresent` and `menloHeaders.policyActionPresent` report whether `x-menlo-disposition` and `x-menlo-policy-action` are present, without logging their values. `menloBlocked` is true only for HTTP 403 with a matching block header. False does not rule out Menlo as the intermediary or source of the refusal.

To verify that the model has successfully switched and is communicating properly:

1. **Check Model Selection**
   - Ensure the Fujitsu-GAP custom model is active in the GitHub Copilot Chat model selection dropdown.
2. **Send a Test Prompt**
   - Send a simple message (e.g., `Hello` or `Introduce yourself`). Complete the browser authentication popup if prompted.
3. **Check Output Logs**
   - Open **View > Output** in VS Code.
   - Select **"Fujitsu-GAP"** from the top dropdown menu to confirm successful token acquisition and API responses (200 OK).

---
<a id="japanese-description"></a>
## 日本語説明文
この拡張機能は、GitHub Copilot Chat のカスタムモデルとして Azure AD 認証を統合し、VS Code 内で Fujitsu-GAP カスタムモデルを利用可能にします。

### 特徴

- **Azure AD 連携**: Azure Active Directory を使用した安全な認証。
- **カスタムモデル対応**: Fujitsu-GAP カスタムモデルに特化した設計。
- **トークン設定**: 設定から最大入力トークン数を調整可能。

### 設定方法

本拡張機能を利用するには、VS Code で以下の設定を行ってください：

- `fujitsuGap.tenantName`: Azure AD テナント名
- `fujitsuGap.clientId`: Azure AD クライアント ID
- `fujitsuGap.maxInputTokens`: 最大入力トークン数（既定値: 262144）
- `fujitsuGap.verboseLogging`: MSAL の詳細診断ログを開発者ツールの Console に出力します（既定: OFF）。再読み込みなしで反映されます。`Fujitsu-GAP MSAL` で検索してください。個人情報を含むと MSAL が判定したログは除外しますが、共有前に内容を確認し、診断後は OFF に戻してください。

### はじめに

1. 拡張機能をインストールします。
2. VS Code の設定 (`Ctrl+,`) を開きます。
3. `Fujitsu-GAP` を検索し、テナント名とクライアント ID を入力します。
4. チャットを開始します：
    - Copilot Chat を開きます。
    - モデル選択メニューから、**「Fujitsu-GAP」** グループ内の **「Fujitsu Cloud Service Generative AI Platform Custom Model」** を選択します。

### 動作確認・モデル切り替えの確認方法

OpenID 構成取得の HTTP 403 は詳細ログが OFF でもエラー通知します。Menlo の応答ヘッダーで拒否を確認できた場合のみ Menlo Security と表示します。通知が表示された場合は、Windows のプロキシ設定を確認し、VS Code を再起動してください。同じ通知は60秒間抑制し、HTTP 2xx の応答後は抑制を解除します。

詳細ログが ON の間は `Fujitsu-GAP MSAL HTTP` に OpenID 構成取得の HTTP ステータス、Content-Type、応答の型、必須項目の有無、形式を制限したエラーコードも出力します。HTTP 診断では URL、応答本文全体、Cookie、認証ヘッダー、トークンは記録せず、通信経路や再試行は変更しません。

`menloHeaders.dispositionPresent` と `menloHeaders.policyActionPresent` は、それぞれ `x-menlo-disposition` と `x-menlo-policy-action` の有無です。`menloBlocked` は HTTP 403 かつ既存の拒否条件に一致した場合のみ `true` です。ヘッダー値は記録せず、`false` でも Menlo を経由していないことや拒否元が Menlo ではないことを意味しません。

正しく Fujitsu-GAP のカスタムモデルに切り替わり、接続できているかを確認するには以下の手順を行います：

1. **チャットパネルでの選択状態の確認**
   - GitHub Copilot Chat のモデル選択ドロップダウンを開き、Fujitsu-GAP のカスタムモデルが選択されていることを確認します。
2. **テストプロンプトの送信**
   - チャット上で簡単なメッセージ（例: `こんにちは`）を送信し、初回の場合はブラウザ認証を完了させます。
3. **出力ログの確認**
   - VS Code のメニューから **「表示」 > 「出力」** を選択します。
   - 上部のドロップダウンから **「Fujitsu-GAP」** を選択し、認証成功や API リクエストのログが出力されていることを確認します。

