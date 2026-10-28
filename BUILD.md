# VSIX パッケージのビルド方法

このドキュメントでは、本拡張機能のソースコードから `.vsix` パッケージを生成（ビルド）する手順について説明します。

## 開発環境の準備

VSIX パッケージを生成するには、以下のツールが必要です。

1. **Node.js (LTS推奨)**
   - [nodejs.org](https://nodejs.org/) からインストールしてください。
   - インストール後、ターミナルで `npm -v` を実行し、バージョンが表示されることを確認してください。

2. **vsce (Visual Studio Code Extension Manager)**
   - VSIX パッケージを作成するためのツールです。
   - 以下のコマンドでインストールできます。
     ```bash
     npm install -g @vscode/vsce
     ```

## ビルド手順

1. **依存パッケージのインストール**
   プロジェクトのルートディレクトリで以下のコマンドを実行します。
   ```bash
   npm install
   ```

2. **TypeScript のコンパイル**
   ソースコードを JavaScript にコンパイルします。
   ```bash
   npm run compile
   ```

3. **VSIX パッケージの生成**
   以下のコマンドを実行して、`.vsix` ファイルを生成します。
   ```bash
   npx vsce package
   ```

実行が完了すると、ルートディレクトリに `fujitsu-gap-copilot-1.0.0.vsix` (バージョン番号は package.json に依存) が生成されます。

## 注意事項
- `package.json` の `publisher` フィールドが正しく設定されていない場合、`vsce package` 実行時にエラーが発生することがあります。
- パイプラインでビルドを行う場合は、`azure-pipelines.yml` の設定に従って自動的にビルドされます。
