import {concat, map, share, switchMap} from 'rxjs/operators';
import {Apollo, QueryRef} from 'apollo-angular';
import {Injectable} from '@angular/core';
import {getChatsQuery} from '../../graphql/getChats.query';
import {AddChat, AddGroup, AddMessage, GetChat, GetChats, GetUsers, RemoveAllMessages, RemoveChat, RemoveMessages} from '../../graphql';
import {getChatQuery} from '../../graphql/getChat.query';
import {addMessageMutation} from '../../graphql/addMessage.mutation';
import {removeChatMutation} from '../../graphql/removeChat.mutation';
import {DocumentNode} from 'graphql';
import {removeAllMessagesMutation} from '../../graphql/removeAllMessages.mutation';
import {removeMessagesMutation} from '../../graphql/removeMessages.mutation';
import {getUsersQuery} from '../../graphql/getUsers.query';
import {Observable, AsyncSubject, of} from 'rxjs';
import {addChatMutation} from '../../graphql/addChat.mutation';
import {addGroupMutation} from '../../graphql/addGroup.mutation';
import * as moment from 'moment';
import {FetchResult} from 'apollo-link';
import {LoginService} from '../login/services/login.service';

@Injectable()
export class ChatsService {
  messagesAmount = 3;
  getChatsWq: QueryRef<GetChats.Query, GetChats.Variables>;
  chats$: Observable<GetChats.Chats[]>;
  chats: GetChats.Chats[];
  getChatWqSubject: AsyncSubject<QueryRef<GetChat.Query>>;
  addChat$: Observable<FetchResult<AddChat.Mutation | AddGroup.Mutation>>;

  constructor(private apollo: Apollo,
              private loginService: LoginService) {
    this.getChatsWq = this.apollo.watchQuery<GetChats.Query, GetChats.Variables>({
      query: getChatsQuery,
      variables: {
        amount: this.messagesAmount,
      },
    });
    this.chats$ = this.getChatsWq.valueChanges.pipe(
      map((result) => result.data.chats)
    );
    this.chats$.subscribe(chats => this.chats = chats);
  }

  static getRandomId() {
    return String(Math.round(Math.random() * 1000000000000));
  }

  getChats() {
    return {query: this.getChatsWq, chats$: this.chats$};
  }

  getChat(chatId: string, oui?: boolean) {
    const _chat = this.chats && this.chats.find(chat => chat.id === chatId) || {
      id: chatId,
      name: '',
      picture: null,
      allTimeMembers: [],
      unreadMessages: 0,
      isGroup: false,
      messages: [],
    };
    const chat$FromCache = of<GetChat.Chat>(_chat);

    const getApolloWatchQuery = (id: string) => {
      return this.apollo.watchQuery<GetChat.Query, GetChat.Variables>({
        query: getChatQuery,
        variables: {
          chatId: id,
        }
      });
    };

    let chat$: Observable<GetChat.Chat>;
    this.getChatWqSubject = new AsyncSubject();

    if (oui) {
      chat$ = chat$FromCache.pipe(
        concat(this.addChat$.pipe(
          switchMap(({ data: { addChat, addGroup } }) => {
            const query = getApolloWatchQuery(addChat ? addChat.id : addGroup.id);

            this.getChatWqSubject.next(query);
            this.getChatWqSubject.complete();

            return query.valueChanges.pipe(
              map((result) => result.data.chat)
            );
          }))
        ));
    } else {
      const query = getApolloWatchQuery(chatId);

      this.getChatWqSubject.next(query);
      this.getChatWqSubject.complete();

      chat$ = chat$FromCache.pipe(
        concat(query.valueChanges.pipe(
          map((result) => result.data.chat)
        )));
    }

    return {query$: this.getChatWqSubject.asObservable(), chat$};
  }

  addMessage(chatId: string, content: string) {
    return this.apollo.mutate<AddMessage.Mutation, AddMessage.Variables>({
      mutation: addMessageMutation,
      variables: {
        chatId,
        content,
      },
      optimisticResponse: {
        __typename: 'Mutation',
        addMessage: {
          id: ChatsService.getRandomId(),
          __typename: 'Message',
          senderId: this.loginService.getUser().id,
          sender: {
            id: this.loginService.getUser().id,
            __typename: 'User',
            name: this.loginService.getUser().name,
          },
          content,
          createdAt: moment().unix(),
          type: 0,
          recipients: [],
          ownership: true,
        },
      },
      update: (store, { data: { addMessage } }: {data: AddMessage.Mutation}) => {
        // Update the messages cache
        {
          // Read the data from our cache for this query.
          const {chat} = store.readQuery<GetChat.Query, GetChat.Variables>({
            query: getChatQuery, variables: {
              chatId,
            }
          });
          // Add our message from the mutation to the end.
          chat.messages.push(addMessage);
          // Write our data back to the cache.
          store.writeQuery({ query: getChatQuery, data: {chat} });
        }
        // Update last message cache
        {
          // Read the data from our cache for this query.
          const {chats} = store.readQuery<GetChats.Query, GetChats.Variables>({
            query: getChatsQuery,
            variables: {
              amount: this.messagesAmount,
            },
          });
          // Add our comment from the mutation to the end.
          chats.find(chat => chat.id === chatId).messages.push(addMessage);
          // Write our data back to the cache.
          store.writeQuery<GetChats.Query, GetChats.Variables>({
            query: getChatsQuery,
            variables: {
              amount: this.messagesAmount,
            },
            data: {
              chats,
            },
          });
        }
      },
    });
  }

  removeChat(chatId: string) {
    return this.apollo.mutate<RemoveChat.Mutation, RemoveChat.Variables>({
      mutation: removeChatMutation,
      variables: {
        chatId,
      },
      optimisticResponse: {
        __typename: 'Mutation',
        removeChat: chatId,
      },
      update: (store, { data: { removeChat } }) => {
        // Read the data from our cache for this query.
        const {chats} = store.readQuery<GetChats.Query, GetChats.Variables>({
          query: getChatsQuery,
          variables: {
            amount: this.messagesAmount,
          },
        });
        // Remove the chat (mutable)
        for (const index of chats.keys()) {
          if (chats[index].id === removeChat) {
            chats.splice(index, 1);
          }
        }
        // Write our data back to the cache.
        store.writeQuery<GetChats.Query, GetChats.Variables>({
          query: getChatsQuery,
          variables: {
            amount: this.messagesAmount,
          },
          data: {
            chats,
          },
        });
      },
    });
  }

  removeMessages(chatId: string, messages: GetChat.Messages[], messageIdsOrAll: string[] | boolean) {
    let variables: RemoveMessages.Variables | RemoveAllMessages.Variables;
    let ids: string[] = [];
    let mutation: DocumentNode;

    if (typeof messageIdsOrAll === 'boolean') {
      variables = {chatId, all: messageIdsOrAll} as RemoveAllMessages.Variables;
      ids = messages.map(message => message.id);
      mutation = removeAllMessagesMutation;
    } else {
      variables = {chatId, messageIds: messageIdsOrAll} as RemoveMessages.Variables;
      ids = messageIdsOrAll;
      mutation = removeMessagesMutation;
    }

    return this.apollo.mutate<
      RemoveMessages.Mutation | RemoveAllMessages.Mutation,
      RemoveMessages.Variables | RemoveAllMessages.Variables
    >({
      mutation,
      variables,
      optimisticResponse: {
        __typename: 'Mutation',
        removeMessages: ids,
      },
      update: (store, { data: { removeMessages } }: {data: RemoveMessages.Mutation | RemoveAllMessages.Mutation}) => {
        // Update the messages cache
        {
          // Read the data from our cache for this query.
          const {chat} = store.readQuery<GetChat.Query, GetChat.Variables>({
            query: getChatQuery, variables: {
              chatId,
            }
          });
          // Remove the messages (mutable)
          removeMessages.forEach(messageId => {
            for (const index of chat.messages.keys()) {
              if (chat.messages[index].id === messageId) {
                chat.messages.splice(index, 1);
              }
            }
          });
          // Write our data back to the cache.
          store.writeQuery<GetChat.Query, GetChat.Variables>({ query: getChatQuery, data: {chat} });
        }
        // Update last message cache
        {
          // Read the data from our cache for this query.
          const {chats} = store.readQuery<GetChats.Query, GetChats.Variables>({
            query: getChatsQuery,
            variables: {
              amount: this.messagesAmount,
            },
          });
          // Fix last message
          chats.find(chat => chat.id === chatId).messages = messages
            .filter(message => !ids.includes(message.id))
            .sort((a, b) => Number(b.createdAt) - Number(a.createdAt)) || [];
          // Write our data back to the cache.
          store.writeQuery<GetChats.Query, GetChats.Variables>({
            query: getChatsQuery,
            variables: {
              amount: this.messagesAmount,
            },
            data: {
              chats,
            },
          });
        }
      },
    });
  }

  getUsers() {
    const query = this.apollo.watchQuery<GetUsers.Query, GetUsers.Variables>({
      query: getUsersQuery,
    });
    const users$ = query.valueChanges.pipe(
      map((result) => result.data.users)
    );

    return {query, users$};
  }

  // Checks if the chat is listed for the current user and returns the id
  getChatId(recipientId: string) {
    const _chat = this.chats.find(chat => {
      return !chat.isGroup && !!chat.allTimeMembers.find(user => user.id === this.loginService.getUser().id) &&
        !!chat.allTimeMembers.find(user => user.id === recipientId);
    });
    return _chat ? _chat.id : false;
  }

  addChat(recipientId: string, users: GetUsers.Users[], ouiId: string) {
    this.addChat$ = this.apollo.mutate<AddChat.Mutation, AddChat.Variables>({
      mutation: addChatMutation,
      variables: {
        recipientId,
      },
      optimisticResponse: {
        __typename: 'Mutation',
        addChat: {
          id: ouiId,
          __typename: 'Chat',
          name: users.find(user => user.id === recipientId).name,
          picture: users.find(user => user.id === recipientId).picture,
          allTimeMembers: [
            {
              id: this.loginService.getUser().id,
              __typename: 'User',
            },
            {
              id: recipientId,
              __typename: 'User',
            }
          ],
          unreadMessages: 0,
          messages: [],
          isGroup: false,
        },
      },
      update: (store, { data: { addChat } }) => {
        // Read the data from our cache for this query.
        const {chats} = store.readQuery<GetChats.Query, GetChats.Variables>({
          query: getChatsQuery,
          variables: {
            amount: this.messagesAmount,
          },
        });
        // Add our comment from the mutation to the end.
        chats.push(addChat);
        // Write our data back to the cache.
        store.writeQuery<GetChats.Query, GetChats.Variables>({
          query: getChatsQuery,
          variables: {
            amount: this.messagesAmount,
          },
          data: {
            chats,
          },
        });
      },
    }).pipe(share());
    return this.addChat$;
  }

  addGroup(recipientIds: string[], groupName: string, ouiId: string) {
    this.addChat$ = this.apollo.mutate<AddGroup.Mutation, AddGroup.Variables>({
      mutation: addGroupMutation,
      variables: {
        recipientIds,
        groupName,
      },
      optimisticResponse: {
        __typename: 'Mutation',
        addGroup: {
          id: ouiId,
          __typename: 'Chat',
          name: groupName,
          picture: 'https://randomuser.me/api/portraits/thumb/lego/1.jpg',
          userIds: [this.loginService.getUser().id, recipientIds],
          allTimeMembers: [
            {
              id: this.loginService.getUser().id,
              __typename: 'User',
            },
            ...recipientIds.map(id => ({id, __typename: 'User'})),
          ],
          unreadMessages: 0,
          messages: [],
          isGroup: true,
        },
      },
      update: (store, { data: { addGroup } }) => {
        // Read the data from our cache for this query.
        const {chats} = store.readQuery<GetChats.Query, GetChats.Variables>({
          query: getChatsQuery,
          variables: {
            amount: this.messagesAmount,
          },
        });
        // Add our comment from the mutation to the end.
        chats.push(addGroup);
        // Write our data back to the cache.
        store.writeQuery<GetChats.Query, GetChats.Variables>({
          query: getChatsQuery,
          variables: {
            amount: this.messagesAmount,
          },
          data: {
            chats,
          },
        });
      },
    }).pipe(share());
    return this.addChat$;
  }
}
