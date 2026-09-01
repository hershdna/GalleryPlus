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

## Frontend installation

Install this repository as a SillyTavern third-party extension, or copy it into
SillyTavern's third-party extensions directory.

## Required server plugin for file organization

Custom ordering works in the frontend alone. Moving removed images into the
nested `deprecated` folder and opening source folders in Windows Explorer
require the included opt-in server plugin:

1. Copy `server-plugin` to `SillyTavern/plugins/galleryplus`.
2. Set `enableServerPlugins: true` in SillyTavern's `config.yaml`.
3. Restart SillyTavern.

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

