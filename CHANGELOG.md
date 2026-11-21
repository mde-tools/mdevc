# Change Log

## 1.0.5

- Add an example of table check boxes and Excel copy and paste, with screenshots, to the README.

## 1.0.4

- Right-click an image for Image Size to resize it (25% to 200% of the original size). The size is saved as a `width` attribute, so the image has the same size on GitHub and in other Markdown apps. "100% (Original Size)" returns the image to the `![text](path)` form.
- Fixed: the size of images sized with `style="zoom:50%;"` was ignored.

## 1.0.3

* Replace the README screenshots with language-specific ones

## 1.0.2

- Tables: Up / Down in a cell with several lines moves between its lines, and from the top / bottom line to the cell above / below. Entering a table with Up / Down from the paragraph before or after it goes to the cell in the same column.
- Tables: Enter moves to the cell below (out of the table from the last row). Shift+Enter breaks the line inside a cell (saved as `<br>`).
- Typing `[text](URL)`, `<https://...>`, or `<name@example.com>` turns it into a link.
- Right-click a link for Open Link, Copy URL, Edit Link…, and Remove Link.
- "Back to Top" is now at the top of the right-click menu.
- After pasting an image, the cursor moves to the next line.
- Fixed: formatting with spaces at its edges, overlapping formatting, and bold + italic could be saved in a form that did not read back the same.
- Fixed: joining a paragraph to a heading with BackSpace or Delete changed the font size.
- Fixed: `_italic_` was rewritten as `*italic*`, and `*` / `_` inside inline code were read as formatting.
- The help now covers every operation.

## 1.0.1

* Improve the README

## 1.0.0

- Initial release
