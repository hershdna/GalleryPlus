# GalleryPlus server plugin

This opt-in SillyTavern server plugin moves gallery files into a nested
`deprecated` folder and opens gallery source folders in Windows Explorer. It
never deletes the source file.

1. Copy this `server-plugin` directory to `SillyTavern/plugins/galleryplus`.
2. Set `enableServerPlugins: true` in SillyTavern's `config.yaml`.
3. Restart SillyTavern.

The UI uses `/api/plugins/galleryplus/archive` when Remove mode is active and
`/api/plugins/galleryplus/open-folder` when the source-folder button is clicked.
Both routes restrict requests to a single gallery folder beneath the current
user's images directory.

