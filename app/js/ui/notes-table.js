/**
 * Notes Table - displays user notes with filtering and actions.
 * @module ui/notes-table
 */

import { App, Storage } from './core.js';
import { Templates } from './templates.js';

export const NotesTable = {
    filter: 'all',
    
    init() {
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.filter = btn.dataset.filter;
                
                document.querySelectorAll('.filter-btn').forEach(b => {
                    const isActive = b === btn;
                    b.setAttribute('aria-selected', isActive);
                    b.classList.toggle('bg-dark-700', isActive);
                    b.classList.toggle('text-dark-50', isActive);
                    b.classList.toggle('text-dark-400', !isActive);
                });
                
                this.render();
            });
        });
        
        this.render();
    },
    
    /**
     * Reloads notes from storage and re-renders the table.
     * Call this when the account changes to show the correct notes.
     */
    async reload() {
        await Storage.load();
        this.render();
    },
    
    render() {
        const tbody = document.getElementById('notes-tbody');
        const empty = document.getElementById('empty-notes');
        
        // Clear
        tbody.replaceChildren();
        
        // Filter and sort
        let notes = [...App.state.notes];
        if (this.filter === 'unspent') notes = notes.filter(n => !n.spent);
        if (this.filter === 'spent') notes = notes.filter(n => n.spent);
        notes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        if (notes.length === 0) {
            empty.classList.remove('hidden');
            empty.classList.add('flex');

            // Show context-aware empty message
            const emptyMsg = empty.querySelector('p');
            if (emptyMsg) {
                const allNotes = App.state.notes;
                if (this.filter === 'spent' && allNotes.length > 0) {
                    emptyMsg.textContent = 'No spent notes yet.';
                } else if (this.filter === 'unspent' && allNotes.length > 0) {
                    emptyMsg.textContent = 'All notes have been spent.';
                } else {
                    emptyMsg.textContent = 'No notes yet. Make a deposit to create your first note.';
                }
            }
            return;
        }
        
        empty.classList.add('hidden');
        empty.classList.remove('flex');
        
        notes.forEach(note => {
            tbody.appendChild(Templates.createNoteRow(note));
        });
    }
};
