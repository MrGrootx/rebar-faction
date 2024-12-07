import * as alt from 'alt-server';
import { useRebar } from '@Server/index.js';
import { FactionCore, Factions, Grades } from '../shared/interface.js';
import { Character } from '@Shared/types/character.js';
import * as Utility from '@Shared/utility/index.js';
import { DefaultRanks } from '../shared/defaultData.js';

const API_NAME = 'faction-handlers-api';
const Rebar = useRebar();
const db = Rebar.database.useDatabase();
const getter = Rebar.get.usePlayerGetter();
const api = Rebar.useApi();
const { useCurrency } = await api.getAsync('currency-api');

const FACTION_COLLECTION = 'Factions';

const factions: { [key: string]: Factions } = {};
type FactionChangeCallback = (_id: string, fieldName: string) => void;
const callbacks: FactionChangeCallback[] = [];

class InternalFunctions {
    static update(faction: Factions) {
        factions[faction._id as string] = faction;
    }
}

async function init() {
    const factionList = await db.getAll<{ _id: string }>(FACTION_COLLECTION);
    if (factionList.length === 0) {
        alt.logWarning(`No Factions have been created`);
        return;
    }

    for (const { _id } of factionList) {
        const [fullFaction] = await db.getMany<Factions>({ _id }, FACTION_COLLECTION);
        if (fullFaction) {
            InternalFunctions.update(fullFaction);
        }
    }
}

export function useFactionHandlers() {
    async function create(characterOwnerID: number, _faction: FactionCore): Promise<any> {
        if (!_faction.factionName) {
            alt.logWarning(`Cannot create faction, missing faction name.`);
            return { status: false, response: `Cannot create faction, missing faction name.` };
        }

        const [character] = await db.getMany<Character>({ id: characterOwnerID }, 'Characters');
        if (!character) {
            alt.logWarning(`Could not find a character with identifier: ${characterOwnerID}`);
            return { status: false, response: `Could not find a character with identifier: ${characterOwnerID}` };
        }

        if (character.faction) {
            return { status: false, response: `Character is already in a faction.` };
        }

        const defaultRanks = Utility.clone.objectData<Array<Grades>>(DefaultRanks).map((rank) => ({
            ...rank,
            gradeId: Rebar.utility.sha256Random(JSON.stringify(rank)),
        }));

        const faction: Factions = {
            ..._faction,
            bank: _faction.bank ?? 0,
            members: {
                [characterOwnerID]: {
                    id: characterOwnerID,
                    name: character.name,
                    duty: true,
                    gradeId: defaultRanks[0].gradeId,
                    isOwner: true,
                },
            },
            grades: defaultRanks,
            locations: {},
            vehicles: [],
        };

        const existingFactions = await db.getMany<Factions>({ factionName: _faction.factionName }, FACTION_COLLECTION);
        if (existingFactions.length > 0) {
            return { status: false, response: `Cannot insert faction into database.` };
        }

        const document = await db.create<Factions>(faction, FACTION_COLLECTION);
        if (!document) {
            return { status: false, response: `Cannot insert faction into database.` };
        }

        const factionId = document.toString();
        faction._id = factionId;
        InternalFunctions.update(faction);

        character.faction = factionId;
        await db.update({ _id: character._id, faction: character.faction }, 'Characters');

        return { status: true, response: factionId };
    }

    async function remove(_id: string): Promise<any> {
        const faction = factions[_id];
        if (!faction) {
            return { status: false, response: `Faction was not found with id: ${_id}` };
        }

        delete factions[_id];

        const ownerIdentifier = Object.values(faction.members).find((member) => member.isOwner)?.id;

        const members = await db.getMany<Character>({ faction: faction._id as string }, 'Characters');
        let onlinePlayers: Array<alt.Player> = [];
        for (const member of members) {
            member.faction = null;
            const xPlayer: alt.Player = getter.byCharacter(member._id);

            if (xPlayer && Rebar.document.character.useCharacter(xPlayer).isValid()) {
                const character = Rebar.document.character.useCharacter(xPlayer);
                await character.set('faction', '');

                if (character.get().id === ownerIdentifier) {
                    const characterCurrency = useCurrency(xPlayer, 'Character');
                    await characterCurrency.add('bank', faction.bank);
                }

                onlinePlayers.push(xPlayer);
            } else if (member.id === ownerIdentifier) {
                member.bank += faction.bank;
                await db.update({ _id: ownerIdentifier, bank: member.bank }, 'Characters');
            }
        }

        for (const vehicle of faction.vehicles) {
            const altVehicle = alt.Vehicle.all.find((v) => v && v.valid && v.id.toString() === vehicle.vehicleId);
            if (altVehicle) altVehicle.destroy();

            await db.deleteDocument(vehicle.vehicleId, 'Vehicles');
        }

        return { status: true, response: `Deleted faction successfully` };
    }

    async function update(_id: string, fieldName: string, partialObject: Partial<Factions>): Promise<any> {
        const faction = factions[_id];
        if (!faction) {
            return { status: false, response: `Faction was not found with id: ${_id}` };
        }

        try {
            await db.update({ _id, [fieldName]: partialObject[fieldName] }, FACTION_COLLECTION);
            callbacks.forEach((cb) => cb(_id, fieldName));
            return { status: true, response: `Updated Faction Data` };
        } catch (err) {
            console.error(err);
            return { status: false, response: `Failed to update faction data.` };
        }
    }

    function findFactionById(_id: string): Factions | null {
        return factions[_id] || null;
    }

    function findFactionByName(nameOrPartialName: string): Factions | null {
        const normalizedQuery = nameOrPartialName.replace(/ /g, '').toLowerCase();
        return (
            Object.values(factions).find((faction) =>
                faction.factionName.replace(/ /g, '').toLowerCase().includes(normalizedQuery),
            ) || null
        );
    }

    function getAllFactions(): Array<Factions> {
        return Object.values(factions);
    }

    function onUpdate(callback: FactionChangeCallback) {
        callbacks.push(callback);
    }

    return {
        create,
        remove,
        update,
        onUpdate,
        findFactionByName,
        findFactionById,
        getAllFactions,
    };
}

declare global {
    export interface ServerPlugin {
        [API_NAME]: ReturnType<typeof useFactionHandlers>;
    }
}

Rebar.useApi().register(API_NAME, useFactionHandlers());

init();
