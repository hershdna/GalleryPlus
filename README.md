# GalleryPlus

GalleryPlus enhances SillyTavern's built-in gallery with a playable slideshow,
custom image ordering, and safe gallery organization.

## Features

- Slideshow playback across the complete gallery, including paginated images
- Previous/next, play/pause, fullscreen, speed, Cut/Fade, and randomize controls
- Full-image window fitting with black letterboxing instead of cropping
- Slideshow playback and live image synchronization after the gallery closes
- Ctrl+Left, Ctrl+Right, and Ctrl+Space keyboard shortcuts
- A **Custom** gallery sort mode with drag-and-drop thumbnail reordering
- Safe Remove mode that moves files to `<gallery folder>/deprecated`
- A gallery control that opens the current source folder in Windows Explorer
- Scroll-wheel or hover zoom and click-and-drag panning

## Recommended combined installation

Install the complete GalleryPlus repository under SillyTavern's `plugins`
directory:

1. Clone or copy this repository to `SillyTavern/plugins/GalleryPlus`.
2. Set `enableServerPlugins: true` in SillyTavern's `config.yaml`.
3. Restart SillyTavern.

On startup, the server plugin synchronizes the bundled `manifest.json`,
`index.js`, `style.css`, and `settings.html` into SillyTavern's third-party
extensions directory. A single repository update therefore updates both halves
of GalleryPlus after the next restart.

If an older standalone `galleryplus` server-plugin folder is installed, replace
it with this complete repository instead of keeping both copies. Two copies use
the same plugin ID and cannot be loaded together.

## Frontend-only installation

The repository can still be installed as a normal SillyTavern third-party
extension. Slideshows and custom ordering work in frontend-only mode, but safe
removal and opening Windows Explorer require the combined installation above.

The server plugin validates the gallery folder and filename, creates the
`deprecated` directory when needed, and moves the file. If a filename already
exists there, it adds a numeric suffix instead of overwriting it.

## Opening the source folder

Click the folder-open control next to the gallery folder field. GalleryPlus asks
the server plugin to open that gallery's source directory in Windows Explorer.

## Using custom order

Choose **Custom** in the gallery's order dropdown, then drag thumbnails to the
desired position. Reordering automatically switches the gallery to Custom.
Newly added files are appended to the stored custom order.

## Removing an image

Click the archive-box control next to the gallery folder field to enable Remove
mode, then click an image and confirm. The original file is moved into the
source gallery's `deprecated` subfolder; it is never permanently deleted.

## Development

The modular source is in `src/`. Build the release script with:

```sh
npm install
npm run build
```

