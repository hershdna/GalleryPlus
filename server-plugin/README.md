# GalleryPlus server plugin

This opt-in SillyTavern server plugin moves gallery files into a nested
`deprecated` folder and opens gallery source folders in Windows Explorer. It
never deletes the source file.

For a combined installation, clone or copy the complete GalleryPlus repository
to `SillyTavern/plugins/GalleryPlus` rather than copying this subdirectory.

1. Place the complete repository at `SillyTavern/plugins/GalleryPlus`.
2. Set `enableServerPlugins: true` in SillyTavern's `config.yaml`.
3. Restart SillyTavern.

The plugin synchronizes the frontend extension files on startup, so updating
that one repository and restarting SillyTavern updates both components.

The UI uses `/api/plugins/galleryplus/archive` when Remove mode is active and
`/api/plugins/galleryplus/open-folder` when the source-folder button is clicked.
Both routes restrict requests to a single gallery folder beneath the current
user's images directory.

