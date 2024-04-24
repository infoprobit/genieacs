import m, { Child, Children, ClosureComponent, Component, VnodeDOM } from 'mithril';
import * as store from './store.ts';
import * as notifications from './notifications.ts';
import { clear, commit, deleteTask, getQueue, getStaging, QueueTask, queueTask, StageTask } from './task-queue.ts';

const invalid: WeakSet<StageTask> = new WeakSet();

function mparam(param): Children {
    return m('span.parameter', {title: param}, `${param}`);
}

function mval(val): Children {
    return m('span.value', {title: val}, `${val}`);
}

function renderStagingSpv(task: StageTask, queueFunc, cancelFunc): Children {
    function keydown(e: KeyboardEvent): void {
        if (e.key === 'Enter') queueFunc();
        else if (e.key === 'Escape') cancelFunc();
        else e['redraw'] = false;
    }

    let input;
    if (task.parameterValues[0][2] === 'xsd:boolean') {
        input = m(
            'select',
            {
                class    : 'form-select boolean',
                value    : task.parameterValues[0][1].toString(),
                onchange : (e) => {
                    e.redraw                   = false;
                    task.parameterValues[0][1] = input.dom.value;
                },
                onkeydown: keydown,
                oncreate : (vnode) => {
                    (vnode.dom as HTMLSelectElement).focus();
                },
            },
            [
                m('option', {value: 'true'}, 'true'),
                m('option', {value: 'false'}, 'false'),
            ],
        );
    } else {
        const type = task.parameterValues[0][2];
        let value  = task.parameterValues[0][1];
        if (type === 'xsd:dateTime' && typeof value === 'number')
            value = new Date(value).toJSON() || value;
        input = m('input', {
            class    : 'form-control',
            type     : ['xsd:int', 'xsd:unsignedInt'].includes(type) ? 'number' : 'text',
            value    : value,
            oninput  : (e) => {
                e.redraw                   = false;
                task.parameterValues[0][1] = input.dom.value;
            },
            onkeydown: keydown,
            oncreate : (vnode) => {
                (vnode.dom as HTMLInputElement).focus();
                (vnode.dom as HTMLInputElement).select();
                // Need to prevent scrolling on focus because
                // we're animating height and using overflow: hidden
                (vnode.dom.parentNode.parentNode as Element).scrollTop = 0;
            },
        });
    }

    return [m('span', 'Editing ', mparam(task.parameterValues[0][0])), input];
}

function renderStagingDownload(task: StageTask): Children {
    if (!task.fileName || !task.fileType) invalid.add(task);
    else invalid.delete(task);
    const files      = store.fetch('files', true);
    let oui          = '';
    let productClass = '';
    for (const d of task.devices) {
        const parts = d.split('-');
        if (oui === '') oui = parts[0];
        else if (oui !== parts[0]) oui = null;
        if (parts.length === 3) {
            if (productClass === '') productClass = parts[1];
            else if (productClass !== parts[1]) productClass = null;
        }
    }

    if (oui) oui = decodeURIComponent(oui);
    if (productClass) productClass = decodeURIComponent(productClass);

    const typesList = [
        ...new Set([
                       '',
                       '1 Firmware Upgrade Image',
                       '2 Web Content',
                       '3 Vendor Configuration File',
                       '4 Tone File',
                       '5 Ringer File',
                       ...files.value.map((f) => f['metadata.fileType']).filter((f) => f),
                   ]),
    ].map((t) => m('option', {disabled: !t, value: t, selected: (task.fileType || '') === t}, t));

    const filesList = ['']
        .concat(
            files.value
                .filter((f) =>
                            (!f['metadata.oui'] || f['metadata.oui'] === oui) &&
                            (!f['metadata.productClass'] || f['metadata.productClass'] === productClass),
                ).map((f) => f._id),
        ).map((f) => m('option', {disabled: !f, value: f, selected: (task.fileName || '') === f}, f));

    return m(
        'div.row.g-2',
        [
            m(
                'div.col-md-6',
                m('label.form-label', 'Push'),
                m('select', {
                    onchange: (e) => {
                        const f       = e.target.value;
                        task.fileName = f;
                        task.fileType = '';
                        for (const file of files.value)
                            if (file._id === f) task.fileType = file['metadata.fileType'];
                    },
                    disabled: files.fulfilling,
                    class   : 'form-select',
                }, filesList),
            ),
            m(
                'div.col-md-6',
                m('label.form-label', 'as'),
                m('select', {
                    class   : 'form-select',
                    onchange: (e) => {
                        task.fileType = e.target.value;
                    },
                }, typesList),
            ),
        ],
    );
}

function renderStaging(stagingItems: Set<StageTask>): Child[] {
    const elements: Child[] = [];

    for (const item of stagingItems) {
        const queueFunc  = (): void => {
            stagingItems.delete(item);
            for (const d of item.devices) {
                const t = Object.assign({device: d}, item);
                delete t.devices;
                queueTask(t);
            }
        };
        const cancelFunc = (): void => {
            stagingItems.delete(item);
        };

        let elms;
        if (item.name === 'setParameterValues')
            elms = renderStagingSpv(item, queueFunc, cancelFunc);

        if (item.name === 'download')
            elms = renderStagingDownload(item);

        const queue  = m(
            'button.btn.btn-sm.btn-outline-success',
            {title: 'Queue Task', onclick: queueFunc, disabled: invalid.has(item)},
            'Queue',
        );
        const cancel = m(
            'button.btn.btn-sm.btn-outline-danger',
            {title: 'Cancel Edit', onclick: cancelFunc},
            'Cancel',
        );

        elements.push(m('.staging', elms, m('div.actions', queue, cancel)));
    }
    return elements;
}

function renderQueue(queueItems: Set<QueueTask>): Child[] {
    const details: Child[]                       = [];
    const devices: { [deviceId: string]: any[] } = {};
    for (const item of queueItems) {
        devices[item.device] = devices[item.device] || [];
        devices[item.device].push(item);
    }

    for (const [k, v] of Object.entries(devices)) {
        details.push(m('strong', k));
        for (const t of v) {
            const actions = [];

            if (t.status === 'fault' || t.status === 'stale') {
                actions.push(
                    m(
                        'button.btn.btn-sm.btn-outline-success',
                        {
                            title  : 'Retry Task',
                            onclick: () => {
                                queueTask(t);
                            },
                        }, m('i.bi.bi-arrow-clockwise'),
                    ),
                );
            }

            actions.push(
                m(
                    'button.btn.btn-sm.btn-outline-danger',
                    {
                        title  : 'Remove Task',
                        onclick: () => {
                            deleteTask(t);
                        },
                    }, m('i.bi.bi-trash'),
                ),
            );

            if (t.name === 'setParameterValues') {
                details.push(
                    m(
                        `div.${t.status}`,
                        m(
                            'span',
                            ['Set ', mparam(t.parameterValues[0][0]), ' to \'', mval(t.parameterValues[0][1]), '\''],
                        ),
                        m('.actions', actions),
                    ),
                );
            } else if (t.name === 'refreshObject') {
                details.push(
                    m(
                        `div.${t.status}`,
                        m('span', 'Refresh ', mparam(t.parameterName)),
                        m('.actions', actions),
                    ),
                );
            } else if (t.name === 'reboot') {
                details.push(m(`div.${t.status}`, [m('span', 'Reboot'), m('.actions', actions)]));
            } else if (t.name === 'factoryReset') {
                details.push(
                    m(`div.${t.status}`, [m('span', 'Factory Reset'), m('.actions', actions)]),
                );
            } else if (t.name === 'addObject') {
                details.push(
                    m(
                        `div.${t.status}`,
                        m('span', 'Add ', mparam(t.objectName)),
                        m('.actions', actions),
                    ),
                );
            } else if (t.name === 'deleteObject') {
                details.push(
                    m(
                        `div.${t.status}`,
                        m('span', 'Delete ', mparam(t.objectName)),
                        m('.actions', actions),
                    ),
                );
            } else if (t.name === 'getParameterValues') {
                details.push(
                    m(
                        `div.${t.status}`,
                        m('span', `Refresh ${t.parameterNames.length} parameters`),
                        m('.actions', actions),
                    ),
                );
            } else if (t.name === 'download') {
                details.push(
                    m(
                        `div.${t.status}`,
                        m('span', `Push file: ${t.fileName} (${t.fileType})`),
                        m('.actions', actions),
                    ),
                );
            } else {
                details.push(m(`div.${t.status}`, t.name, m('.actions', actions)));
            }
        }
    }

    return details;
}

const alert = {
    'success'  : 'alert-success',
    'warning'  : 'alert-warning',
    'error'    : 'alert-danger',
    'primary'  : 'alert-primary',
    'secondary': 'alert-secondary',
    'info'     : 'alert-info',
    'light'    : 'alert-light',
    'dark'     : 'alert-dark',
};

function renderNotifications(notificationItems): Child[] {
    const notificationElements: Child[] = [];

    for (const item of notificationItems) {
        let buttons;
        if (item.actions) {
            const btns = Object
                .entries(item.actions)
                .map(([label, onclick]) => m('button.btn.btn-sm.btn-outline-success', {onclick: onclick}, label));
            if (btns.length) buttons = m('div.float-end', btns);
        }

        notificationElements.push(
            m(
                'div.alert',
                {
                    class         : alert[item.type] || alert['primary'],
                    key           : item.timestamp,
                    onbeforeremove: () => {
                        return new Promise<void>((resolve) => {
                            setTimeout(() => {
                                resolve();
                            }, 5000);
                        });
                    },
                },
                [buttons, item.message],
            ),
        );
    }
    return notificationElements;
}

const component: ClosureComponent = (): Component => {
    return {
        view: (vnode) => {
            const queueItems        = getQueue();
            const stagingItems      = getStaging();
            const notificationItems = notifications.getNotifications();

            let drawerElement, statusElement;
            const notificationElements = renderNotifications(notificationItems);
            const queueElements        = renderQueue(queueItems);
            const stagingElements      = renderStaging(stagingItems);

            function resizeDrawer(): void {
                let height = statusElement.dom.offsetTop + statusElement.dom.offsetHeight;
                for (const c of drawerElement.children) {
                    height = Math.max(height, c.dom.offsetTop + c.dom.offsetHeight);
                }
                if (stagingElements.length) {
                    for (const s of stagingElements as VnodeDOM[]) {
                        height = Math.max(
                            height, (s.dom as HTMLDivElement).offsetTop + (s.dom as HTMLDivElement).offsetHeight,
                        );
                    }
                }
                drawerElement.dom.style.height = height + 'px';
            }

            if (stagingElements.length + queueElements.length) {
                const statusCount = {queued: 0, pending: 0, fault: 0, stale: 0};
                for (const t of queueItems) statusCount[t['status']] += 1;

                const actions = m(
                    '.actions',
                    m(
                        'button.btn.btn-sm.btn-outline-success',
                        {
                            title   : 'Commit Queued Tasks',
                            disabled: !statusCount.queued,
                            onclick : () => {
                                const tasks = Array.from(getQueue()).filter(
                                    (t) => t['status'] === 'queued',
                                );
                                commit(
                                    tasks,
                                    (deviceId, err, connectionRequestStatus, tasks2) => {
                                        if (err) {
                                            notifications.push('error', `${deviceId}: ${err.message}`);
                                            return;
                                        }

                                        if (connectionRequestStatus !== 'OK') {
                                            notifications.push('error', `${deviceId}: ${connectionRequestStatus}`);
                                            return;
                                        }

                                        for (const t of tasks2) {
                                            if (t.status === 'stale') {
                                                notifications.push('error', `${deviceId}: No contact from device`);
                                                return;
                                            } else if (t.status === 'fault') {
                                                notifications.push('error', `${deviceId}: Task(s) faulted`);
                                                return;
                                            }
                                        }
                                        notifications.push('success', `${deviceId}: Task(s) committed`);
                                    },
                                )
                                    .then(() => {
                                        store.setTimestamp(Date.now());
                                    })
                                    .catch((err) => {
                                        notifications.push('error', err.message);
                                    });
                            },
                        },
                        'Commit',
                    ),
                    m(
                        'button.btn.btn-sm.btn-outline-danger',
                        {title: 'Clear Tasks', onclick: clear, disabled: !queueElements.length},
                        'Clear',
                    ),
                );

                statusElement = m(
                    '.status',
                    m('span.queued', {class: statusCount.queued ? 'active' : ''}, `Queued: ${statusCount.queued}`),
                    m('span.pending', {class: statusCount.pending ? 'active' : ''}, `Pending: ${statusCount.pending}`),
                    m('span.fault', {class: statusCount.fault ? 'active' : ''}, `Fault: ${statusCount.fault}`),
                    m('span.stale', {class: statusCount.stale ? 'active' : ''}, `Stale: ${statusCount.stale}`),
                    actions,
                );

                drawerElement = m(
                    'div',
                    {
                        class         : 'drawer alert ' + alert['light'],
                        key           : 'drawer',
                        style         : 'opacity: 0;height: 0;',
                        oncreate      : (vnode2) => {
                            vnode.state['mouseIn']                       = false;
                            (vnode2.dom as HTMLDivElement).style.opacity = '1';
                            resizeDrawer();
                        },
                        onmouseover   : (e) => {
                            vnode.state['mouseIn'] = true;
                            resizeDrawer();
                            e.redraw = false;
                        },
                        onmouseleave  : (e) => {
                            vnode.state['mouseIn'] = false;
                            resizeDrawer();
                            e.redraw = false;
                        },
                        onupdate      : resizeDrawer,
                        onbeforeremove: (vnode2) => {
                            (vnode2.dom as HTMLDivElement).onmouseover   = null;
                            (vnode2.dom as HTMLDivElement).onmouseleave  = null;
                            (vnode2.dom as HTMLDivElement).style.opacity = '0';
                            (vnode2.dom as HTMLDivElement).style.height  = '0';
                            return new Promise((resolve) => {
                                setTimeout(resolve, 5000);
                            });
                        },
                    },
                    statusElement,
                    stagingElements.length ? stagingElements : m('.queue', queueElements),
                );
            }

            const elements = [];
            if (drawerElement !== undefined)
                notificationElements.push(drawerElement);

            return m('div.drawer-wrapper', notificationElements);
        },
    };
};

export default component;
