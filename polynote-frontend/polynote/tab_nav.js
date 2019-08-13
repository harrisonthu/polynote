"use strict";

import {UIEventTarget, UIEvent} from "./ui_event";
import {div} from "./tags";

export class TabNavSelected extends UIEvent {
    constructor(tabId) {
        super('TabNavSelected', {tabId});
        this.tabId = tabId;
    }
}

export class TabNav extends UIEventTarget {

    constructor(items) {
        super();
        this.items = items;
        const itemNames = Object.keys(items);
        const firstItemName = itemNames.shift();
        this.container = div(['tab-nav'], [
            div(['tab-nav-items'], this.itemLabels = [
                div(['tab-nav-item', 'active'], [firstItemName]).attr('name', firstItemName).click(evt => this.showItem(firstItemName)),
                ...itemNames.map(name => div(['tab-nav-item'], [name]).attr('name', name).click(evt => this.showItem(name)))
            ]),
            this.content = div(['tab-nav-content'], [])
        ]);

        this.showItem(firstItemName);
    }

    showItem(name) {
        if (this.selectedItem === name) {
            return;
        }
        const newLabel = this.itemLabels.find(label => label.getAttribute('name') === name);
        if (!newLabel) {
            return;
        }

        if (this.selectedItem) this.itemLabels.find(label => label.getAttribute('name') === this.selectedItem).classList.remove('active');

        newLabel.classList.add('active');

        while (this.content.childNodes.length) {
            this.content.removeChild(this.content.childNodes[0]);
        }

        let tabContent = this.items[name];
        if (typeof tabContent === "function") {
            tabContent = tabContent();
        }

        this.content.appendChild(tabContent);

        this.selectedItem = name;
    }

}