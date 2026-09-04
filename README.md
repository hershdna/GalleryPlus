# GalleryPlus

GalleryPlus enhances SillyTavern's built-in gallery with a playable slideshow,
custom image ordering, and safe gallery organization.

## Features

- Slideshow playback across the complete gallery, including paginated images
- A live slide-position slider and current/total counter
- `.mp4`, `.mov`, and `.webm` gallery items and mixed-media slideshows
- Previous/next, stateful play/pause and no-repeat shuffle cycles, fullscreen, timing, and Cut/Fade controls
- Global video mute and minimum video play-time controls
- Real video-frame thumbnails and a highlighted slideshow toggle for native video controls
- Full-image window fitting with black letterboxing instead of cropping
- Slideshow playback and live image synchronization after the gallery closes
- Ctrl+Left, Ctrl+Right, and Ctrl+Space keyboard shortcuts
- A **Custom** gallery sort mode with drag-and-drop thumbnail reordering
- Cross-page reordering by holding a thumbnail over a pagination icon
- Clickable and drag-scrubbable pagination icons, with thumbnail-area page flipping disabled
- Safe Remove mode that moves files to `<gallery folder>/deprecated`
- A gallery control that opens the current source folder in Windows Explorer
- Per-gallery external file/folder addresses, including supported media in nested folders
- Immediate gallery opening with validated external media populated progressively in the background
- Automatic omission of missing, unreadable, corrupt, unsupported, and durationless external media
- Per-gallery file-type filters shared by the thumbnail view and slideshow
- Scroll-wheel or hover zoom and click-and-drag panning

Short videos repeat until the configured minimum video play time is reached.
GalleryPlus advances only after the current repetition finishes; videos longer
than the minimum play once in full.

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
removal, external file/folder addresses, and opening Windows Explorer require
the combined installation above.

The server plugin validates the gallery folder and filename, creates the
`deprecated` directory when needed, and moves the file. If a filename already
exists there, it adds a numeric suffix instead of overwriting it.

## Opening the source folder

Click the folder-open control next to the gallery folder field. GalleryPlus asks
the server plugin to open that gallery's source directory in Windows Explorer.

## Adding files from other locations

Click the link control next to the gallery folder field to open the External
Files and Folders window. Enter one full file or folder address per line, then click **Apply**. Folder addresses are scanned
recursively for supported image and video files. The addresses are saved for
the current gallery folder, while the original files stay in place. To remove
an external item from the gallery, edit or remove its address from this list.
Large folders are scanned and validated in the background. External entries are
never included in SillyTavern's blocking window-opening request, so the gallery
opens with local items first and adds playable media in small batches. Files that
cannot be displayed, and videos without a usable duration, are omitted.

## Filtering file types

Click the filter control next to the gallery folder field to open the centered
File Types window, choose the image and video extensions to include, then click **Apply**. The selection is saved for
the current gallery and filters both gallery thumbnails and slideshow playback.

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
