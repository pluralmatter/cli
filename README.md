# Plural Matter CLI

Talk to an evolving Plural Matter mind from your terminal.

## Install

```bash
npm install --global pluralmatter
```

Node.js 24 or newer is required.

## Get started

Create a project API key in the [Plural Matter platform](https://platform.pluralmatter.com), then run:

```bash
pluralmatter login
pluralmatter mind create
pluralmatter chat
```

`login` accepts the API key through a hidden prompt and saves it in an
owner-only configuration file. A newly created mind becomes the default for
`send` and `chat` automatically.

Use one-shot messages when composing with other terminal tools:

```bash
pluralmatter send "I'm building a robotics startup"
pluralmatter send "What do you know about me?"
```

Choose a provider or another mind for one session:

```bash
pluralmatter chat --provider gemini --mind-id mind_...
```

Inside chat, use `/help`, `/edit`, `/clear`, `/info`, or `/exit`. Chat shows
public mind-update progress, but never displays recalled content or mind
internals.

## Mind commands

```bash
pluralmatter mind create [name]
pluralmatter mind list
pluralmatter mind use <mind-id>
pluralmatter mind inspect [mind-id]
```

Run `pluralmatter --help` for all options and environment overrides.

## Development

```bash
npm install
npm test
npm run pack:check
```

The CLI exposes only Plural Matter's documented public product contract. It
does not contain the private mind implementation or service internals.

## License

Licensed under the [Apache License 2.0](LICENSE).
